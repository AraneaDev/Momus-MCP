import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RustFile } from './ast.ts';

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  // Minimal WebAssembly typings — tsconfig `lib` is ES2022 and @types/node does not
  // declare the WebAssembly globals (they normally come from lib.dom).
  namespace WebAssembly {
    class Module {
      constructor(bufferSource: ArrayBuffer | ArrayBufferView);
    }
    class Instance {
      constructor(module: Module, importObject?: object);
      readonly exports: Record<string, unknown>;
    }
    class Memory {
      constructor(descriptor: { initial: number; maximum?: number });
      readonly buffer: ArrayBuffer;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const WASM_PATH = join(import.meta.dirname, '..', 'wasm', 'pkg', 'momus-syn-wasm.wasm');

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  parse_file(ptr: number, len: number): number;
  result_len(): number;
}

let exports: WasmExports | null = null;

function load(): WasmExports {
  if (exports) return exports;
  const bytes = readFileSync(WASM_PATH);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  exports = instance.exports as unknown as WasmExports;
  return exports;
}

/** Parse Rust source synchronously into the JSON AST. Throws only on loader failure. */
export function parseRust(source: string): RustFile {
  const wasm = load();
  const enc = new TextEncoder();
  const input = enc.encode(source);
  const inPtr = wasm.alloc(input.length);
  new Uint8Array(wasm.memory.buffer, inPtr, input.length).set(input);
  const outPtr = wasm.parse_file(inPtr, input.length);
  const len = wasm.result_len();
  const json = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outPtr, len));
  return JSON.parse(json) as RustFile;
}
