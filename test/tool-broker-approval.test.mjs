import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { createToolBroker } from '../src/tools/tool-broker.mjs';

test('approved mutation authorization is forwarded only through the internal execution option', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'tool-broker-approval-test-'));

  try {
    const broker = createToolBroker(projectRoot, {
      allowWrites: false,
      allowedCommands: []
    });

    await assert.rejects(
      () =>
        broker.execute({
          name: 'write_file',
          arguments: {
            path: 'approved.txt',
            content: 'should not write'
          }
        }),
      /approval|denied|disabled/i
    );

    let authorizationDetails = null;

    const result = await broker.execute(
      {
        name: 'write_file',
        arguments: {
          path: 'approved.txt',
          content: 'approved write'
        }
      },
      {
        approvedMutationAuthorization: async details => {
          authorizationDetails = details;
          return true;
        }
      }
    );

    assert.equal(result.changed, true);
    assert.equal(result.path, 'approved.txt');
    assert.ok(authorizationDetails);
    assert.equal(authorizationDetails.operation, 'write');
    assert.equal(authorizationDetails.path, 'approved.txt');

    const persisted = await readFile(join(projectRoot, 'approved.txt'), 'utf8');
    assert.equal(persisted, 'approved write');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('approved patch authorization is forwarded through the same internal execution boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'tool-broker-patch-approval-test-'));

  try {
    const broker = createToolBroker(projectRoot, {
      allowWrites: false,
      allowedCommands: []
    });

    await broker.execute(
      {
        name: 'write_file',
        arguments: {
          path: 'patch-target.txt',
          content: 'before content\n'
        }
      },
      {
        approvedMutationAuthorization: () => true
      }
    );

    let authorizationDetails = null;

    const result = await broker.execute(
      {
        name: 'patch_file',
        arguments: {
          path: 'patch-target.txt',
          patch: {
            targetContent: 'before content',
            replacementContent: 'after content'
          }
        }
      },
      {
        approvedMutationAuthorization: async details => {
          authorizationDetails = details;
          return true;
        }
      }
    );

    assert.equal(result.changed, true);
    assert.ok(authorizationDetails);
    assert.equal(authorizationDetails.operation, 'patch');
    assert.equal(authorizationDetails.path, 'patch-target.txt');

    const persisted = await readFile(
      join(projectRoot, 'patch-target.txt'),
      'utf8'
    );

    assert.equal(persisted, 'after content\n');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
