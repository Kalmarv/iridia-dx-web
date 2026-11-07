//! The old path (`src/legacy.rs`) is to be deleted once the IR has its own analyses and constant folding, not kept
//! beside it.
//!
//! Expected to fail until then: while the file exists the test panics, which `should_panic` counts as a pass. Once it
//! is deleted the test fails, and the fix is to drop `should_panic`, so that the test keeps it deleted.

#[test]
#[should_panic(expected = "legacy.rs still exists")]
fn the_old_path_is_deleted() {
    let legacy = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/legacy.rs");
    assert!(
        !legacy.exists(),
        "legacy.rs still exists: the Flow analyses and constant folding read its naga modules until they are on the IR"
    );
}
