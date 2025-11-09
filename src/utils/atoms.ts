import { atom } from 'jotai'

// global live status message
export const statusAtom = atom('')

// updating Utxo
export const updatingUtxoAtom = atom(false)

// user Utxo balance
export const userUtxoAmount = atom(0)

// user SOL balance
export const userSOLAmount = atom(0)

// deposit state
export const isDepositingAtom = atom(false)

// withdraw state
export const isWithdrawingAtom = atom(false)

// hasher
export const hasherAtom = atom<any>(null)

// hasher loading state to prevent concurrent loads
export const hasherLoadingAtom = atom(false)

// modal
export const showModalAtom = atom(false)

export const showWalletSelector = atom(false)

// toggle between deposit, withdraw, and transfer views
export const viewModeAtom = atom<'deposit' | 'withdraw' | 'transfer' | 'swap'>('deposit')