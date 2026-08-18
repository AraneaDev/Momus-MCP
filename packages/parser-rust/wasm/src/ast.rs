//! Serialize a `syn::File` into a JSON AST (`serde_json::Value`) for the TypeScript parser.
//! Field names are camelCase (matching `packages/parser-rust/src/ast.ts`). Spans carry only
//! 1-based `line`/`column` (byte offsets are not needed and would require the full
//! `span-locations` source map plumbing).

use quote::ToTokens;
use serde_json::{json, Value};

pub fn file(f: &syn::File) -> Value {
    json!({
        "items": f.items.iter().map(item).collect::<Vec<_>>(),
    })
}

fn item(it: &syn::Item) -> Value {
    match it {
        syn::Item::Fn(f) => json!({
            "kind": "fn",
            "name": f.sig.ident.to_string(),
            "attrs": f.attrs.iter().map(attr).collect::<Vec<_>>(),
            "sig": sig(&f.sig),
            "body": block_exprs(&f.block),
            "span": span_of(&f.sig.ident),
        }),
        syn::Item::Struct(s) => json!({
            "kind": "struct",
            "name": s.ident.to_string(),
            "attrs": s.attrs.iter().map(attr).collect::<Vec<_>>(),
            "fields": fields(&s.fields),
            "span": span_of(&s.ident),
        }),
        syn::Item::Enum(e) => json!({
            "kind": "enum",
            "name": e.ident.to_string(),
            "attrs": e.attrs.iter().map(attr).collect::<Vec<_>>(),
            "variants": e.variants.iter().map(|v| json!({
                "name": v.ident.to_string(),
                "type": Value::Null,
                "span": span_of(&v.ident),
            })).collect::<Vec<_>>(),
            "span": span_of(&e.ident),
        }),
        syn::Item::Trait(t) => json!({
            "kind": "trait",
            "name": t.ident.to_string(),
            "attrs": t.attrs.iter().map(attr).collect::<Vec<_>>(),
            "supertraits": t.supertraits.iter().filter_map(supertrait_name).collect::<Vec<_>>(),
            "items": t.items.iter().filter_map(trait_item).collect::<Vec<_>>(),
            "span": span_of(&t.ident),
        }),
        syn::Item::Impl(imp) => json!({
            "kind": "impl",
            "attrs": imp.attrs.iter().map(attr).collect::<Vec<_>>(),
            "traitPath": imp.trait_.as_ref().map(|(_, path, _)| path_text(path)),
            "selfType": type_(&imp.self_ty),
            "items": imp.items.iter().filter_map(impl_item).collect::<Vec<_>>(),
            "span": span_of(&imp),
        }),
        syn::Item::Type(t) => json!({
            "kind": "type",
            "name": t.ident.to_string(),
            "attrs": t.attrs.iter().map(attr).collect::<Vec<_>>(),
            "type": type_(&t.ty),
            "span": span_of(&t.ident),
        }),
        syn::Item::Mod(m) => json!({
            "kind": "mod",
            "name": m.ident.to_string(),
            "attrs": m.attrs.iter().map(attr).collect::<Vec<_>>(),
            "items": m.content.as_ref()
                .map(|(_, items)| items.iter().map(item).collect::<Vec<_>>())
                .unwrap_or_default(),
            "span": span_of(&m.ident),
        }),
        syn::Item::Use(u) => {
            let (path, alias, glob) = use_tree(&u.tree, Vec::new());
            json!({
                "kind": "use",
                "path": path,
                "alias": alias,
                "glob": glob,
                "span": span_of(&u),
            })
        }
        syn::Item::ForeignMod(f) => json!({
            // `extern "C" { fn x(…); … }` — mock_derive's `#[mock]` on an extern block generates an
            // `Extern<Abi>Mocks` static mock (`ExternCMocks`, `ExternRustMocks`), so the parser needs
            // the ABI name + the foreign fn names (and the `#[mock]` attr) to detect it.
            "kind": "extern",
            "name": f.abi.name.as_ref().map(|l| l.value()).unwrap_or_default(),
            "attrs": f.attrs.iter().map(attr).collect::<Vec<_>>(),
            "items": f.items.iter().map(foreign_item).collect::<Vec<_>>(),
            "span": span_of(f),
        }),
        syn::Item::Macro(m) => json!({
            "kind": "macro",
            "path": path_text(&m.mac.path),
            "tokens": m.mac.tokens.to_string(),
            "span": span_of(&m.mac),
        }),
        _ => json!({ "kind": "other", "name": "item", "attrs": [], "span": span_of(it) }),
    }
}

fn foreign_item(fi: &syn::ForeignItem) -> Value {
    match fi {
        syn::ForeignItem::Fn(f) => json!({
            "name": f.sig.ident.to_string(),
            "sig": sig(&f.sig),
            "span": span_of(&f.sig.ident),
        }),
        syn::ForeignItem::Static(s) => json!({
            "name": s.ident.to_string(),
            "span": span_of(&s.ident),
        }),
        _ => json!({ "name": "", "span": span_of(fi) }),
    }
}

/// The last path segment of a trait supertrait bound (`trait Derived : Base` -> `Base`;
/// `trait X : std::fmt::Debug` -> `Debug`). Lifetime bounds (`: 'static`) are dropped.
fn supertrait_name(b: &syn::TypeParamBound) -> Option<String> {
    match b {
        syn::TypeParamBound::Trait(tb) => tb.path.segments.last().map(|s| s.ident.to_string()),
        _ => None,
    }
}

fn trait_item(ti: &syn::TraitItem) -> Option<Value> {
    match ti {
        syn::TraitItem::Fn(f) => Some(json!({
            "name": f.sig.ident.to_string(),
            "sig": sig(&f.sig),
            "span": span_of(&f.sig.ident),
        })),
        syn::TraitItem::Type(t) => Some(json!({ "name": t.ident.to_string(), "span": span_of(&t.ident) })),
        syn::TraitItem::Const(c) => Some(json!({ "name": c.ident.to_string(), "span": span_of(&c.ident) })),
        _ => None,
    }
}

fn impl_item(it: &syn::ImplItem) -> Option<Value> {
    match it {
        syn::ImplItem::Fn(f) => Some(json!({
            "kind": "fn",
            "name": f.sig.ident.to_string(),
            "attrs": f.attrs.iter().map(attr).collect::<Vec<_>>(),
            "sig": sig(&f.sig),
            "body": Vec::<Value>::new(),
            "span": span_of(&f.sig.ident),
        })),
        _ => None,
    }
}

fn fields(fs: &syn::Fields) -> Vec<Value> {
    match fs {
        syn::Fields::Named(n) => n.named.iter().map(field).collect(),
        syn::Fields::Unnamed(u) => u
            .unnamed
            .iter()
            .enumerate()
            .map(|(i, f)| json!({ "name": i.to_string(), "type": type_(&f.ty), "span": span_of(f) }))
            .collect(),
        syn::Fields::Unit => Vec::new(),
    }
}

fn field(f: &syn::Field) -> Value {
    json!({
        "name": f.ident.as_ref().map(|i| i.to_string()).unwrap_or_default(),
        "type": type_(&f.ty),
        "span": span_of(f),
    })
}

fn sig(s: &syn::Signature) -> Value {
    json!({
        "params": s.inputs.iter().filter_map(param).collect::<Vec<_>>(),
        "returnType": match &s.output {
            syn::ReturnType::Default => Value::Null,
            syn::ReturnType::Type(_, t) => type_(t),
        },
        "isAsync": s.asyncness.is_some(),
        "generics": s.generics.params.iter().filter_map(generic_name).collect::<Vec<_>>(),
    })
}

fn generic_name(p: &syn::GenericParam) -> Option<String> {
    match p {
        syn::GenericParam::Type(t) => Some(t.ident.to_string()),
        syn::GenericParam::Lifetime(l) => Some(l.lifetime.ident.to_string()),
        syn::GenericParam::Const(c) => Some(c.ident.to_string()),
    }
}

fn param(arg: &syn::FnArg) -> Option<Value> {
    match arg {
        syn::FnArg::Typed(pt) => match &*pt.pat {
            syn::Pat::Ident(pi) => Some(json!({
                "name": pi.ident.to_string(),
                "type": type_(&pt.ty),
            })),
            _ => None,
        },
        syn::FnArg::Receiver(_) => None, // &self / &mut self carry no useful type for drift rules
    }
}

fn type_(t: &syn::Type) -> Value {
    let text = t.to_token_stream().to_string();
    match t {
        syn::Type::Path(tp) => {
            let name = tp.path.segments.last().map(|s| s.ident.to_string()).unwrap_or_default();
            let mut args: Vec<Value> = Vec::new();
            if let Some(last) = tp.path.segments.last() {
                if let syn::PathArguments::AngleBracketed(ab) = &last.arguments {
                    args = ab
                        .args
                        .iter()
                        .filter_map(|a| match a {
                            syn::GenericArgument::Type(t) => Some(type_(t)),
                            _ => None,
                        })
                        .collect();
                }
            }
            json!({ "text": text, "kind": "named", "name": name, "args": args, "span": span_of(t) })
        }
        syn::Type::Reference(r) => json!({
            "text": text,
            "kind": "reference",
            "name": r.elem.to_token_stream().to_string(),
            "lifetime": r.lifetime.as_ref().map(|l| l.to_string()),
            "mutable": r.mutability.is_some(),
            "span": span_of(t),
        }),
        syn::Type::Tuple(tup) if tup.elems.is_empty() => json!({ "text": text, "kind": "unit", "span": span_of(t) }),
        syn::Type::Tuple(tup) => json!({
            "text": text,
            "kind": "tuple",
            "elements": tup.elems.iter().map(type_).collect::<Vec<_>>(),
            "span": span_of(t),
        }),
        syn::Type::Slice(s) => json!({
            "text": text,
            "kind": "slice",
            "elements": vec![type_(&s.elem)],
            "span": span_of(t),
        }),
        syn::Type::Array(a) => json!({
            "text": text,
            "kind": "array",
            "elements": vec![type_(&a.elem)],
            "len": a.len.to_token_stream().to_string(),
            "span": span_of(t),
        }),
        syn::Type::ImplTrait(_) => json!({ "text": text, "kind": "impl-trait", "span": span_of(t) }),
        syn::Type::Never(_) => json!({ "text": text, "kind": "never", "span": span_of(t) }),
        syn::Type::Infer(_) => json!({ "text": text, "kind": "infer", "span": span_of(t) }),
        syn::Type::Paren(p) => type_(&p.elem),
        _ => json!({ "text": text, "kind": "named", "name": text, "span": span_of(t) }),
    }
}

fn block_exprs(block: &syn::Block) -> Vec<Value> {
    let mut out = Vec::new();
    for stmt in &block.stmts {
        match stmt {
            syn::Stmt::Expr(e, _) => out.push(expr(e)),
            syn::Stmt::Macro(m) => out.push(json!({
                "kind": "macro",
                "text": m.mac.tokens.to_string(),
                "macroPath": path_text(&m.mac.path),
                "args": macro_args(&m.mac.tokens),
                "span": span_of(&m.mac),
            })),
            syn::Stmt::Local(l) => {
                // `let mut m = MockFoo::new();` — surface the initializer expression, tagged
                // with the binding name so TS can associate later `m.method()` invocations.
                // `let (mock, handle) = …;` (tuple destructuring) surfaces `bindings` so mocks
                // can bind their fake (element 0) and config handle (element 1) variables.
                if let Some(init) = &l.init {
                    let mut e = expr(&init.expr);
                    if let Some(obj) = e.as_object_mut() {
                        match &l.pat {
                            syn::Pat::Ident(pi) => {
                                obj.insert("binding".to_string(), json!(pi.ident.to_string()));
                            }
                            syn::Pat::Tuple(pt) => {
                                let names: Vec<String> = pt
                                    .elems
                                    .iter()
                                    .filter_map(|p| match p {
                                        syn::Pat::Ident(pi) => Some(pi.ident.to_string()),
                                        _ => None,
                                    })
                                    .collect();
                                if !names.is_empty() {
                                    obj.insert("bindings".to_string(), json!(names));
                                }
                            }
                            _ => {}
                        }
                    }
                    out.push(e);
                }
            }
            _ => {}
        }
    }
    out
}

fn expr(e: &syn::Expr) -> Value {
    let text = e.to_token_stream().to_string();
    match e {
        syn::Expr::Macro(m) => json!({
            "kind": "macro",
            "text": text,
            "macroPath": path_text(&m.mac.path),
            "args": macro_args(&m.mac.tokens),
            "span": span_of(e),
        }),
        syn::Expr::Call(c) => json!({
            "kind": "call",
            "text": text,
            "callee": callee_of(&c.func),
            "args": c.args.iter().map(expr).collect::<Vec<_>>(),
            "span": span_of(e),
        }),
        syn::Expr::MethodCall(m) => json!({
            "kind": "method-call",
            "text": text,
            "method": m.method.to_string(),
            "receiver": expr(m.receiver.as_ref()),
            "args": m.args.iter().map(expr).collect::<Vec<_>>(),
            "span": span_of(e),
        }),
        syn::Expr::Binary(b) => json!({
            "kind": "binary",
            "text": text,
            "op": b.op.to_token_stream().to_string(),
            "left": expr(b.left.as_ref()),
            "right": expr(b.right.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Lit(l) => json!({
            "kind": "literal",
            "text": text,
            "literal": lit(&l.lit),
            "span": span_of(e),
        }),
        syn::Expr::Path(p) => json!({
            "kind": "path",
            "text": path_text(&p.path),
            "span": span_of(e),
        }),
        syn::Expr::Field(f) => json!({
            "kind": "other",
            "text": text,
            // preserve the base so a nested `mock.foo()` invocation is still walkable
            "receiver": expr(f.base.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Unary(u) => json!({
            "kind": "other",
            "text": text,
            "receiver": expr(u.expr.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Paren(p) => json!({
            "kind": "other",
            "text": text,
            "receiver": expr(p.expr.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Await(a) => json!({
            "kind": "other",
            "text": text,
            // `.await` is transparent: `Mock::given(...).mount(...).await` must stay walkable.
            "receiver": expr(a.base.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Reference(r) => json!({
            "kind": "other",
            "text": text,
            // Preserve the referent so `&mock` args remain walkable (trait-qualified receivers).
            "receiver": expr(r.expr.as_ref()),
            "span": span_of(e),
        }),
        syn::Expr::Block(b) => json!({
            "kind": "block",
            "text": text,
            "stmts": block_exprs(&b.block),
            "span": span_of(e),
        }),
        syn::Expr::Unsafe(u) => json!({
            "kind": "block",
            "text": text,
            // Unsafe blocks execute at runtime — descend so `unsafe { mock.foo() }` counts.
            "stmts": block_exprs(&u.block),
            "span": span_of(e),
        }),
        // Control-flow expressions execute their bodies at runtime — descend so a mock invoked
        // inside `for`/`while`/`loop`/`if`/`match` counts as reached (mockiato `sequential_calls`
        // stubs `bar` then invokes it in a `for` loop).
        syn::Expr::ForLoop(_) | syn::Expr::While(_) | syn::Expr::Loop(_) | syn::Expr::If(_) | syn::Expr::Match(_) => {
            json!({
                "kind": "block",
                "text": text,
                "stmts": control_flow_stmts(e),
                "span": span_of(e),
            })
        },
        syn::Expr::Try(t) => json!({
            "kind": "other",
            "text": text,
            // `?` is transparent: `mock.foo()?` must stay walkable.
            "receiver": expr(t.expr.as_ref()),
            "span": span_of(e),
        }),
        _ => json!({ "kind": "other", "text": text, "span": span_of(e) }),
    }
}

/// Collect the runtime statements of a control-flow expression (`for`/`while`/`loop` bodies,
/// `if` then+else branches, `match` arm bodies) so mock invocations inside them are walked.
fn control_flow_stmts(e: &syn::Expr) -> Vec<Value> {
    match e {
        syn::Expr::Block(b) => block_exprs(&b.block),
        syn::Expr::ForLoop(f) => block_exprs(&f.body),
        syn::Expr::While(w) => block_exprs(&w.body),
        syn::Expr::Loop(l) => block_exprs(&l.body),
        syn::Expr::If(i) => {
            let mut stmts = block_exprs(&i.then_branch);
            if let Some((_, else_expr)) = &i.else_branch {
                stmts.extend(control_flow_stmts(else_expr));
            }
            stmts
        }
        syn::Expr::Match(m) => m.arms.iter().flat_map(|arm| control_flow_stmts(arm.body.as_ref())).collect(),
        _ => Vec::new(),
    }
}

fn callee_of(func: &syn::Expr) -> Value {
    match func {
        syn::Expr::Path(p) => json!({
            "kind": "path",
            "text": callee_path_text(&p.path, p.qself.as_ref()),
            "span": span_of(p),
        }),
        _ => expr(func),
    }
}

/// `<MockFoo as Foo<u32>>::foo` keeps its qualified prefix so the TS layer can recognise
/// UFCS/trait-qualified invocations where the mock is the receiver argument.
fn callee_path_text(p: &syn::Path, qself: Option<&syn::QSelf>) -> String {
    if let Some(q) = qself {
        let ty = q.ty.to_token_stream().to_string();
        let segs: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
        if let Some(_as) = &q.as_token {
            let split = q.position.min(segs.len());
            let trait_path = segs[..split].join("::");
            let rest = segs[split..].join("::");
            format!("<{} as {}>::{}", ty, trait_path, rest)
        } else {
            format!("<{}>::{}", ty, segs.join("::"))
        }
    } else {
        path_text(p)
    }
}

fn macro_args(tokens: &proc_macro2::TokenStream) -> Vec<Value> {
    use syn::parse::Parser;
    let parser = syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated;
    match parser.parse2(tokens.clone()) {
        Ok(p) => p.iter().map(expr).collect(),
        Err(_) => Vec::new(),
    }
}

fn lit(l: &syn::Lit) -> Value {
    match l {
        syn::Lit::Str(s) => json!({ "kind": "string", "value": s.value() }),
        syn::Lit::Int(i) => json!({ "kind": "int", "value": i.base10_digits() }),
        syn::Lit::Float(f) => json!({ "kind": "float", "value": f.base10_digits() }),
        syn::Lit::Bool(b) => json!({ "kind": "bool", "value": if b.value { "true" } else { "false" } }),
        syn::Lit::Char(c) => json!({ "kind": "string", "value": c.value().to_string() }),
        _ => json!({ "kind": "string", "value": l.to_token_stream().to_string() }),
    }
}

fn attr(a: &syn::Attribute) -> Value {
    json!({
        "path": a.path().segments.last().map(|s| s.ident.to_string()).unwrap_or_default(),
        "args": a.meta.require_list().ok().map(|l| l.tokens.to_string()),
    })
}

fn use_tree(tree: &syn::UseTree, mut segs: Vec<String>) -> (String, Option<String>, bool) {
    match tree {
        syn::UseTree::Path(p) => {
            segs.push(p.ident.to_string());
            use_tree(&p.tree, segs)
        }
        syn::UseTree::Name(n) => {
            segs.push(n.ident.to_string());
            (segs.join("::"), None, false)
        }
        syn::UseTree::Rename(r) => {
            segs.push(r.ident.to_string());
            (segs.join("::"), Some(r.rename.to_string()), false)
        }
        syn::UseTree::Glob(_) => (segs.join("::"), None, true),
        syn::UseTree::Group(_) => (segs.join("::"), None, false),
    }
}

fn path_text(p: &syn::Path) -> String {
    p.segments.iter().map(|s| s.ident.to_string()).collect::<Vec<_>>().join("::")
}

fn span_of<T: syn::spanned::Spanned>(x: &T) -> Value {
    let s = x.span();
    let lc = s.start(); // 1-based line/column (proc-macro2 1.x LineColumn)
    json!({ "line": lc.line, "column": lc.column })
}
