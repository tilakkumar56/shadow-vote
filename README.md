# ShadowVote - Private Governance on Solana

Encrypted voting powered by Arcium MPC. Votes encrypted with Rescue cipher and processed by ARX nodes on secret-shared data. Real end-to-end MPC computation.

Live Demo: https://shadow-vote.vercel.app
Program ID: A6aMv9XdGov532ahzgz8MgUMyPeW1cXCp7Ln8w5VmFvw (Solana Devnet)
Explorer: https://explorer.solana.com/address/A6aMv9XdGov532ahzgz8MgUMyPeW1cXCp7Ln8w5VmFvw?cluster=devnet

## How It Works

1. Frontend encrypts vote with Rescue cipher via x25519 ECDH key exchange using official Arcium client SDK
2. Encrypted vote submitted to Solana program which queues MPC computation
3. ARX nodes process vote on secret-shared data - no node sees the vote
4. Callback verifies BLS signature and records result on-chain

## Real End-to-End MPC Flow

- getMXEPublicKey: Fetches MXE x25519 public key from Solana
- x25519.getSharedSecret: Derives shared secret with MPC cluster
- RescueCipher.encrypt: Encrypts vote option, weight, and num_options
- queue_computation: Submits encrypted data to Arcium MPC via Solana program
- awaitComputationFinalization: Waits for ARX nodes to process and callback

## Privacy Guarantees

- Vote secrecy: Individual votes never visible to any party
- MPC enforcement: ARX nodes compute on secret shares only
- On-chain verification: BLS signature verified in callback
- Full-threshold security: ALL nodes must collude to break privacy

## Technical Stack

- Arcis Circuit: cast_vote with VoteInput (option_idx u8, weight u128, num_options u8) returning VoteResult
- Solana Program: initialize, create_proposal, init_cast_vote_comp_def, cast_vote, cast_vote_callback
- Frontend: React + TypeScript + Vite + Arcium Client SDK (RescueCipher, x25519, awaitComputationFinalization)
- Offchain circuit hosted on GitHub for ARX node access

## Deployed on Solana Devnet

- Program: A6aMv9XdGov532ahzgz8MgUMyPeW1cXCp7Ln8w5VmFvw
- MXE: Initialized with cluster migration on cluster 456
- Comp Def: Offchain circuit source with verified hash

## Tech Stack

Solana - Arcium - Arcis - Anchor 0.32.1 - React + Vite - Arcium Client SDK

## License

MIT
