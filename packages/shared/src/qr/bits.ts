/*
 * QR Code generator library (TypeScript)
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

export type bit = number;

export type byte = number;

export type int = number;

// Appends the given number of low-order bits of the given value
// to the given buffer. Requires 0 <= len <= 31 and 0 <= val < 2^len.
export function appendBits(val: int, len: int, bb: Array<bit>): void {
  if (len < 0 || len > 31 || val >>> len != 0) throw new RangeError("Value out of range");

  for (
    let i = len - 1;
    i >= 0;
    i-- // Append bit by bit
  )
    bb.push((val >>> i) & 1);
}

// Returns true iff the i'th bit of x is set to 1.
export function getBit(x: int, i: int): boolean {
  return ((x >>> i) & 1) != 0;
}

// Throws an exception if the given condition is false.
export function assert(cond: boolean): void {
  if (!cond) throw new Error("Assertion error");
}
