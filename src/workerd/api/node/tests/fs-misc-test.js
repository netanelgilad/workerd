// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import { notStrictEqual, strictEqual, throws } from 'node:assert';

// sync and datasync are generally non-ops. The most they do is
// verify that the file descriptor is valid.

import {
  openSync,
  closeSync,
  fsyncSync,
  fdatasyncSync,
  fdatasync,
  fsync,
  statfs,
  statfsSync,
  openAsBlob,
  WriteStream,
  FileWriteStream,
  ReadStream,
  FileReadStream,
  constants,
  F_OK,
  R_OK,
  W_OK,
  X_OK,
  writeFileSync,
  writeSync,
  readFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';

strictEqual(typeof openSync, 'function');
strictEqual(typeof closeSync, 'function');
strictEqual(typeof fdatasyncSync, 'function');
strictEqual(typeof fsyncSync, 'function');
strictEqual(typeof fdatasync, 'function');
strictEqual(typeof fsync, 'function');

const kInvalidArgTypeError = { code: 'ERR_INVALID_ARG_TYPE' };
const kBadFError = { code: 'EBADF' };

export const miscTest = {
  async test() {
    throws(() => fsyncSync(), kInvalidArgTypeError);
    throws(() => fdatasyncSync(), kInvalidArgTypeError);
    throws(() => fsyncSync('hello'), kInvalidArgTypeError);
    throws(() => fdatasyncSync('hello'), kInvalidArgTypeError);
    throws(() => fsync(), kInvalidArgTypeError);
    throws(() => fdatasync(), kInvalidArgTypeError);
    throws(() => fsync('hello'), kInvalidArgTypeError);
    throws(() => fdatasync('hello'), kInvalidArgTypeError);
    throws(() => fsyncSync(123), kBadFError);
    throws(() => fdatasyncSync(123), kBadFError);

    const fd = openSync('/dev/null', 'r');
    fsyncSync(fd);
    fdatasyncSync(fd);

    {
      const { promise, resolve, reject } = Promise.withResolvers();
      fsync(fd, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
      await promise;
    }

    {
      const { promise, resolve, reject } = Promise.withResolvers();
      fdatasync(fd, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
      await promise;
    }

    {
      const { promise, resolve, reject } = Promise.withResolvers();
      fsync(123, (err) => {
        if (!err) {
          reject(new Error('Expected an error'));
          return;
        }
        strictEqual(err.code, 'EBADF');
        resolve();
      });
      await promise;
    }

    {
      const { promise, resolve, reject } = Promise.withResolvers();
      fdatasync(123, (err) => {
        if (!err) {
          reject(new Error('Expected an error'));
          return;
        }
        strictEqual(err.code, 'EBADF');
        resolve();
      });
      await promise;
    }

    closeSync(fd);
  },
};

export const statFsTest = {
  async test() {
    const stat = statfsSync('/');
    strictEqual(typeof stat, 'object');
    strictEqual(stat.type, 0);
    strictEqual(stat.bsize, 0);
    strictEqual(stat.blocks, 0);
    strictEqual(stat.bfree, 0);
    strictEqual(stat.bavail, 0);
    strictEqual(stat.files, 0);
    strictEqual(stat.ffree, 0);

    throws(() => statfsSync(123), {
      code: 'ERR_INVALID_ARG_TYPE',
    });

    throws(() => statfsSync('/does/not/exist', { bigint: 123 }), {
      code: 'ERR_INVALID_ARG_TYPE',
    });

    const { promise, resolve, reject } = Promise.withResolvers();
    statfs('/', (err, stat) => {
      if (err) reject(err);
      else {
        strictEqual(typeof stat, 'object');
        strictEqual(stat.type, 0);
        strictEqual(stat.bsize, 0);
        strictEqual(stat.blocks, 0);
        strictEqual(stat.bfree, 0);
        strictEqual(stat.bavail, 0);
        strictEqual(stat.files, 0);
        strictEqual(stat.ffree, 0);
        resolve();
      }
    });
    await promise;

    throws(() => statfs(123, () => {}), {
      code: 'ERR_INVALID_ARG_TYPE',
    });

    throws(() => statfs('/does/not/exist', { bigint: 123 }), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  },
};

export const pathLimitTest = {
  test() {
    // Trying to open a path longer than 4096 characters should throw an error.
    const longPath = '/tmp/a'.repeat(4097);
    throws(() => openSync(longPath, 'r'), {
      message: /File path is too long/,
    });

    // Trying to open a path with more than 48 segments should throw an error.
    const tooManySegments = '/a'.repeat(49);
    throws(() => openSync(tooManySegments, 'r'), {
      message: /File path has too many segments/,
    });
  },
};

// Regression test for the O_TRUNC ('w' flag) handling in openSync. Opening an
// existing file for writing with 'w' must truncate it to zero length first;
// otherwise writing a SHORTER payload over a LONGER pre-existing file leaves
// stale trailing bytes, producing a corrupt over-long file whose head and tail
// are correct but whose middle/tail is garbage. This is exactly the corruption
// that broke VFS module loading at scale (tar re-extracting a module path,
// emitting a file ~2x its real size). A minimal "many modules where one gets
// truncated" repro: write N files long, then rewrite each shorter with 'w'.
export const truncateOnOpenTest = {
  test() {
    const path = '/tmp/trunc-on-open.mjs';
    const long = 'X'.repeat(11640); // mimic the corrupt 11640-byte filter-index
    const short = 'Y'.repeat(6136); // the real 6136-byte source

    // First write: a long file.
    let fd = openSync(path, 'w');
    writeSync(fd, Buffer.from(long), 0, long.length, 0);
    closeSync(fd);
    strictEqual(statSync(path).size, long.length);

    // Reopen with 'w' and write a SHORTER payload. O_TRUNC must reset to 0,
    // so the result is exactly `short` with no stale tail from `long`.
    fd = openSync(path, 'w');
    writeSync(fd, Buffer.from(short), 0, short.length, 0);
    closeSync(fd);

    strictEqual(statSync(path).size, short.length);
    const got = readFileSync(path, 'utf8');
    strictEqual(got.length, short.length);
    strictEqual(got, short);

    // writeFileSync (whole-file replace) must also truncate.
    writeFileSync(path, long);
    strictEqual(statSync(path).size, long.length);
    writeFileSync(path, short);
    strictEqual(statSync(path).size, short.length);
    strictEqual(readFileSync(path, 'utf8'), short);

    // Many-files variant: one of many co-written files gets rewritten shorter
    // and must not retain stale bytes.
    const N = 50;
    for (let i = 0; i < N; i++) {
      writeFileSync(`/tmp/m${i}.txt`, 'A'.repeat(2000 + i));
    }
    // Rewrite #37 with a much shorter body via the 'w' open path.
    const victim = '/tmp/m37.txt';
    const fd2 = openSync(victim, 'w');
    writeSync(fd2, Buffer.from('tiny'), 0, 4, 0);
    closeSync(fd2);
    strictEqual(statSync(victim).size, 4);
    strictEqual(readFileSync(victim, 'utf8'), 'tiny');

    // 'a' (append) must NOT truncate.
    writeFileSync(path, 'AAA');
    const fdA = openSync(path, 'a');
    writeSync(fdA, Buffer.from('BBB'), 0, 3);
    closeSync(fdA);
    strictEqual(readFileSync(path, 'utf8'), 'AAABBB');

    // 'r+' must NOT truncate (it overwrites in place but preserves length).
    writeFileSync(path, 'hello world');
    const fdR = openSync(path, 'r+');
    writeSync(fdR, Buffer.from('HELLO'), 0, 5, 0);
    closeSync(fdR);
    strictEqual(readFileSync(path, 'utf8'), 'HELLO world');

    unlinkSync(path);
    for (let i = 0; i < N; i++) unlinkSync(`/tmp/m${i}.txt`);
  },
};

export const openAsBlobTest = {
  async test() {
    // We currently do not implement openAsBlob, but let's verify arg validation.
    throws(() => openAsBlob(), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
    throws(() => openAsBlob(1), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
    throws(() => openAsBlob('/', 123), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
    throws(() => openAsBlob('/', { type: 123 }), {
      code: 'ERR_INVALID_ARG_TYPE',
    });

    writeFileSync('/tmp/abc', '123');
    throws(() => openAsBlob('/'), {
      message: /illegal operation on a directory/,
    });
    throws(() => openAsBlob(new URL('file:///')), {
      message: /illegal operation on a directory/,
    });

    const blob = openAsBlob('/tmp/abc', { type: 'text/plain' });
    strictEqual(blob instanceof Blob, true);
    strictEqual(blob.size, 3);
    strictEqual(blob.type, 'text/plain');
    strictEqual(await blob.text(), '123');
  },
};

export const otherExportsTest = {
  test() {
    strictEqual(WriteStream, FileWriteStream);
    strictEqual(ReadStream, FileReadStream);
    strictEqual(constants.F_OK, F_OK);
    strictEqual(constants.R_OK, R_OK);
    strictEqual(constants.W_OK, W_OK);
    strictEqual(constants.X_OK, X_OK);
    notStrictEqual(F_OK, undefined);
    notStrictEqual(R_OK, undefined);
    notStrictEqual(W_OK, undefined);
    notStrictEqual(X_OK, undefined);
    notStrictEqual(WriteStream, undefined);
    notStrictEqual(ReadStream, undefined);
  },
};

export const oobWriteTest = {
  test() {
    const v3 = Buffer.from('Test data for write operations');
    // Open for writing WITH create intent. Previously this opened with the
    // default 'r' flag and relied on the non-POSIX auto-create-on-read (an
    // 'r' open of a missing path silently created an empty file); under POSIX
    // open() a read-only open of a missing file is ENOENT, so a write test must
    // request a create flag.
    const fd = openSync('/tmp/write-test.bin', 'w');
    throws(
      () => {
        strictEqual(writeSync(fd, v3, 10, 10, 4294967295), 0);
      },
      {
        message: /File size limit exceeded/,
      }
    );

    strictEqual(writeSync(fd, v3, 10, 10, 134217718), 10);
  },
};
