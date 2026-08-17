mod ast;

use wee_alloc::WeeAlloc;

#[global_allocator]
static ALLOC: WeeAlloc = WeeAlloc::INIT;

static mut BUFFER: Vec<u8> = Vec::new();

/// Allocate `len` zeroed bytes in the shared buffer and return a pointer (used by the
/// JS loader to stage the UTF-8 input source).
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    unsafe {
        BUFFER = vec![0u8; len];
        BUFFER.as_mut_ptr()
    }
}

/// Parse UTF-8 Rust source (`ptr`/`len`) into a JSON AST, stored in the shared buffer.
/// Returns a pointer to the JSON bytes; `result_len` gives its length.
#[no_mangle]
pub extern "C" fn parse_file(ptr: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json = match std::str::from_utf8(bytes) {
        Ok(src) => match syn::parse_file(src) {
            Ok(file) => {
                serde_json::to_string(&ast::file(&file)).unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e))
            }
            Err(e) => format!("{{\"error\":\"{}\"}}", e),
        },
        Err(_) => "{\"error\":\"invalid utf-8\"}".to_string(),
    };
    unsafe {
        BUFFER = json.into_bytes();
        BUFFER.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { BUFFER.len() }
}
