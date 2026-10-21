// @Author Christian Relf
// @Date 2026-10-21

// Prevents a console window opening alongside the app on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kern_platform_lib::run()
}
