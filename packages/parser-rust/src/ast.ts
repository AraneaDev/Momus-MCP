/** JSON AST shape returned by the syn-wasm loader (mirrors packages/parser-rust/wasm/src/ast.rs). */

export interface RustSpan {
  line: number; // 1-based
  column: number; // 1-based
}

export interface RustAttr {
  path: string;
  args: string | null;
}

export interface RustType {
  text: string;
  kind: 'named' | 'reference' | 'tuple' | 'slice' | 'array' | 'impl-trait' | 'unit' | 'never' | 'infer';
  name?: string;
  args?: RustType[];
  lifetime?: string | null;
  mutable?: boolean;
  elements?: RustType[];
  len?: string | null;
  span: RustSpan;
}

export interface RustParam {
  name: string;
  type: RustType;
}

export interface RustSignature {
  params: RustParam[];
  returnType: RustType | null;
  isAsync: boolean;
  generics: string[];
}

export interface RustLiteral {
  kind: 'string' | 'int' | 'float' | 'bool';
  value: string;
}

export interface RustExpr {
  kind: 'macro' | 'call' | 'method-call' | 'binary' | 'literal' | 'path' | 'other';
  text: string;
  macroPath?: string;
  args?: RustExpr[];
  left?: RustExpr;
  right?: RustExpr;
  op?: string;
  callee?: RustExpr;
  method?: string;
  receiver?: RustExpr;
  literal?: RustLiteral;
  /** Set on the initializer of a `let NAME = <expr>;` so mocks can be tied to their variable. */
  binding?: string;
  span: RustSpan;
}

export interface RustFn {
  kind: 'fn';
  name: string;
  attrs: RustAttr[];
  sig: RustSignature;
  body: RustExpr[];
  span: RustSpan;
}

export interface RustTraitItem {
  name: string;
  sig?: RustSignature;
  span: RustSpan;
}

export interface RustField {
  name: string;
  type: RustType | null;
  span: RustSpan;
}

export interface RustStruct {
  kind: 'struct';
  name: string;
  attrs: RustAttr[];
  fields: RustField[];
  span: RustSpan;
}

export interface RustEnum {
  kind: 'enum';
  name: string;
  attrs: RustAttr[];
  variants: RustField[];
  span: RustSpan;
}

export interface RustTrait {
  kind: 'trait';
  name: string;
  attrs: RustAttr[];
  items: RustTraitItem[];
  span: RustSpan;
}

export interface RustImpl {
  kind: 'impl';
  attrs: RustAttr[];
  traitPath: string | null;
  selfType: RustType;
  items: RustFn[];
  span: RustSpan;
}

export interface RustTypeAlias {
  kind: 'type';
  name: string;
  attrs: RustAttr[];
  type: RustType;
  span: RustSpan;
}

export interface RustMod {
  kind: 'mod';
  name: string;
  attrs: RustAttr[];
  items: RustItem[];
  span: RustSpan;
}

export interface RustUse {
  kind: 'use';
  path: string;
  alias: string | null;
  glob: boolean;
  span: RustSpan;
}

export interface RustMacroCall {
  kind: 'macro';
  path: string;
  tokens: string;
  span: RustSpan;
}

export type RustItem =
  RustFn | RustStruct | RustEnum | RustTrait | RustImpl | RustTypeAlias | RustMod | RustUse | RustMacroCall;

export interface RustFile {
  items: RustItem[];
  error?: string;
}
