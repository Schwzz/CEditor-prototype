// Prevents a release-build console window on Windows; debug builds keep the
// console attached for diagnostics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    framecode_lib::run()
}
