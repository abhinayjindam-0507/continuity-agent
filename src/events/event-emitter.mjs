/**
 * Bounded in-memory event emitter with monotonic sequence numbers and
 * reconnect support for the Continuity Agent SSE stream.
 *
 * Design:
 *  - Events have monotonically increasing integer sequence numbers (1-based).
 *  - A bounded ring-buffer holds the last MAX_BUFFER_SIZE events.
 *  - Reconnecting clients can supply their last received seq and receive
 *    only newer buffered events.
 *  - When the requested seq is older than the retained buffer, the buffer
 *    is safe to return in full (the client should also re-fetch the snapshot).
 *  - SQLite remains the source of truth; this buffer is NOT durable.
 */

import { randomUUID } from 'node:crypto';
import { validateEvent, isValidEventType } from './event-schema.mjs';

export const MAX_BUFFER_SIZE  = 500; // maximum events retained in memory
export const MAX_CLIENTS      = 100; // maximum concurrent SSE connections

/**
 * Creates an event emitter with a bounded ring-buffer and SSE fan-out.
 *
 * @returns {{
 *   emit(taskId, type, payload): object,
 *   subscribe(response): () => void,
 *   getBufferedSince(seq): object[],
 *   getLatestSeq(): number,
 *   clientCount(): number
 * }}
 */
export function createEventEmitter({
  maxBufferSize = MAX_BUFFER_SIZE,
  maxClients = MAX_CLIENTS
} = {}) {
  /** @type {object[]} ordered ring-buffer of emitted events */
  const buffer = [];

  /** @type {number} monotonically increasing sequence counter */
  let seq = 0;

  /** @type {Set<import('http').ServerResponse>} connected SSE clients */
  const clients = new Set();

  /**
   * Emits a typed, schema-validated event to all connected clients and
   * appends it to the ring-buffer.
   *
   * @param {string} taskId
   * @param {string} type  – must be in EVENT_TYPES
   * @param {object} payload – already sanitized caller-provided payload
   * @returns {object} the emitted event
   * @throws {Error} if type is not a valid event type
   */
  function emit(taskId, type, payload) {
    if (!isValidEventType(type)) {
      throw new Error(`emit: unknown event type "${type}"`);
    }
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('emit: taskId must be a non-empty string');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('emit: payload must be a plain object');
    }

    seq += 1;
    const event = Object.freeze({
      id:        String(seq),
      seq,
      taskId:    String(taskId).slice(0, 100),
      timestamp: new Date().toISOString(),
      type,
      payload:   Object.freeze({ ...payload })
    });

    // Validate (defensive; callers should pre-sanitize)
    const { valid, errors } = validateEvent(event);
    if (!valid) {
      throw new Error(`emit: invalid event: ${errors.join('; ')}`);
    }

    // Append to ring-buffer; evict oldest if at capacity
    buffer.push(event);
    if (buffer.length > maxBufferSize) {
      buffer.shift();
    }

    // Fan-out SSE to all connected clients
    const sseMessage = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) {
      try {
        response.write(sseMessage);
      } catch {
        // Client has disconnected; cleanup handled via 'close' handler
        clients.delete(response);
      }
    }

    return event;
  }

  /**
   * Broadcasts an unsequenced raw SSE message (e.g. legacy 'task' event) to all connected clients.
   *
   * @param {string} rawString
   */
  function broadcastRaw(rawString) {
    for (const response of clients) {
      try {
        response.write(rawString);
      } catch {
        clients.delete(response);
      }
    }
  }

  /**
   * Registers a new SSE client.
   * Sends all buffered events since `lastSeq` immediately on connect.
   * If `lastSeq` requested is older than the oldest retained event, sends
   * a `recovery_required` event so the client knows events were evicted and
   * it should reload its state snapshot, followed by retained events.
   * Returns an unsubscribe function.
   *
   * @param {import('http').ServerResponse} response
   * @param {number} [lastSeq=0]  – last event seq the client received
   * @returns {() => void} unsubscribe
   */
  function subscribe(response, lastSeq = 0) {
    if (clients.size >= maxClients) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('Too many SSE clients connected');
      return () => {};
    }

    clients.add(response);

    const n = Number(lastSeq) || 0;
    const oldestSeq = buffer.length > 0 ? buffer[0].seq : 1;

    // If client requested a sequence that was already evicted, notify via event
    if (n > 0 && buffer.length > 0 && n < oldestSeq) {
      try {
        response.write(
          `event: recovery_required\ndata: ${JSON.stringify({
            reason: 'Requested sequence was evicted from event buffer; task snapshot reload recommended',
            requestedSeq: n,
            oldestRetainedSeq: oldestSeq
          })}\n\n`
        );
      } catch {
        clients.delete(response);
        return () => {};
      }
    }

    // Replay buffered events the client missed
    const catchUp = getBufferedSince(n);
    for (const event of catchUp) {
      try {
        response.write(
          `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      } catch {
        clients.delete(response);
        return () => {};
      }
    }

    return function unsubscribe() {
      clients.delete(response);
    };
  }

  /**
   * Returns all buffered events with seq > lastSeq, in order.
   * If lastSeq is older than the oldest retained event, returns the
   * full buffer (safe fallback — client should re-fetch snapshot).
   *
   * @param {number} lastSeq
   * @returns {object[]}
   */
  function getBufferedSince(lastSeq) {
    const n = Number(lastSeq) || 0;
    return buffer.filter(e => e.seq > n);
  }

  /**
   * Checks if any events between lastSeq and the oldest retained event were evicted.
   *
   * @param {number} lastSeq
   * @returns {boolean}
   */
  function hasEvictedSince(lastSeq) {
    const n = Number(lastSeq) || 0;
    return Boolean(n > 0 && buffer.length > 0 && n < buffer[0].seq);
  }

  /**
   * Returns the current (latest emitted) sequence number.
   */
  function getLatestSeq() {
    return seq;
  }

  /**
   * Returns buffer and sequence metrics.
   */
  function getBufferStats() {
    return {
      size: buffer.length,
      maxBufferSize,
      oldestSeq: buffer.length > 0 ? buffer[0].seq : 0,
      latestSeq: seq
    };
  }

  /**
   * Returns the number of currently connected SSE clients.
   */
  function clientCount() {
    return clients.size;
  }

  return {
    emit,
    subscribe,
    broadcastRaw,
    getBufferedSince,
    hasEvictedSince,
    getLatestSeq,
    getBufferStats,
    clientCount
  };
}
