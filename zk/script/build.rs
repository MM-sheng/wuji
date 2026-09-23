// Build the guest ELF so `include_elf!` can find it. Requires the SP1 toolchain.
fn main() {
    sp1_build::build_program("../program");
}
