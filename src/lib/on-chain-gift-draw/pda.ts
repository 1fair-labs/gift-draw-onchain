import { PublicKey } from '@solana/web3.js';
import { getGiftDrawRegistryProgramId, getGiftDrawRegistryProgramIdServer } from './program-id';

export function configPda(programId?: PublicKey): PublicKey {
  const pid = programId ?? new PublicKey(getGiftDrawRegistryProgramIdServer());
  return PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
}

export function drawSeedPda(drawId: string, programId?: PublicKey): PublicKey {
  const pid = programId ?? new PublicKey(getGiftDrawRegistryProgramIdServer());
  return PublicKey.findProgramAddressSync([Buffer.from('draw_seed'), Buffer.from(drawId, 'utf8')], pid)[0];
}

export function drawCommitPda(drawId: string, programId?: PublicKey): PublicKey {
  const pid = programId ?? new PublicKey(getGiftDrawRegistryProgramIdServer());
  return PublicKey.findProgramAddressSync([Buffer.from('draw_commit'), Buffer.from(drawId, 'utf8')], pid)[0];
}

export function getProgramIdPublicKey(clientSide = false): PublicKey {
  const id = clientSide ? getGiftDrawRegistryProgramId() : getGiftDrawRegistryProgramIdServer();
  return new PublicKey(id);
}
