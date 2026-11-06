//! The old path (`src/legacy.rs`) is to be deleted once every example lifts onto the IR, not kept beside it.
//!
//! Expected to fail until then: while the file exists the test panics, which `should_panic` counts as a pass. Once it
//! is deleted the test fails, and the fix is to drop `should_panic`, so that the test keeps it deleted.

#[test]
#[should_panic(expected = "legacy.rs still exists")]
fn the_old_path_is_deleted() {
    let legacy = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/legacy.rs");
    assert!(
        !legacy.exists(),
        "legacy.rs still exists: the DXBC and DXIL examples lift through it until their readers are on the IR"
    );
}
