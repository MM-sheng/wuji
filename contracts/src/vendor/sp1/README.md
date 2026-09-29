# Vendored SP1 verifier (v6.1.0)

Copied unmodified from https://github.com/succinctlabs/sp1-contracts at commit d3629729c3216eb51bd4859d027a8eb729399fa4:
`contracts/src/ISP1Verifier.sol`, `contracts/src/v6.1.0/Groth16Verifier.sol`, `contracts/src/v6.1.0/SP1VerifierGroth16.sol`.
Only change: the import path of `ISP1Verifier.sol` in `SP1VerifierGroth16.sol`. License: MIT (Succinct Labs).
Must match the SP1 circuit version the prover uses (`SP1_CIRCUIT_VERSION` = v6.1.0 for sp1-prover 6.8.0).
