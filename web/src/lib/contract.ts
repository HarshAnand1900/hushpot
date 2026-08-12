/**
 * The live Hushpot deployment and the slice of its ABI the frontend uses.
 *
 * Deployed 12 August 2026 to Sepolia against Zama's official confidential USDT mock, so
 * anyone who took part in an earlier Developer Program season already holds the token.
 *
 * Redeployed from 0x0B6c…Fa4e to carry the parked-award payout, which took a claim from
 * 1.83M gas to 405k by no longer repairing ten ancestor sums to credit an encrypted zero.
 */

export const CHAIN_ID = 11155111;

export const POOL_ADDRESS = "0xf18bB8d788CE868B53928c57422cdeB3020F2Edb" as const;

/** cUSDTMock — "Confidential USDT (Mock)", 6 decimals, rate 1. */
export const TOKEN_ADDRESS = "0x4E7B06D78965594eB5EF5414c357ca21E1554491" as const;

/** USDTMock — plain ERC-20 with an open `mint`, which is the faucet. */
export const UNDERLYING_ADDRESS = "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0" as const;

export const TOKEN_DECIMALS = 6;

/** One draw period, in minutes. Matches PERIOD_MINUTES on-chain. */
export const PERIOD_MINUTES = 10080n;

export const poolAbi = [
  // --- reads: public state -------------------------------------------------
  { type: "function", name: "currentPeriod", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "periodStart", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "PERIOD_SECONDS", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "PERIOD_MINUTES", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "minuteOfPeriod", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "periodEnded", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "slotsUsed", inputs: [], outputs: [{ type: "uint16" }], stateMutability: "view" },
  { type: "function", name: "prizeReserve", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "annualRateBps", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "drawCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "drawPending", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "supportsAutoShield", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "underlyingToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  {
    type: "function",
    name: "prizeFor",
    inputs: [{ name: "total", type: "uint64" }],
    outputs: [{ type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "draws",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "total", type: "uint64" },
      { name: "prize", type: "uint64" },
      { name: "drawPoint", type: "bytes32" },
      { name: "period", type: "uint32" },
      { name: "settled", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "slotOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasSlot",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "slotOwner",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimChecked",
    inputs: [{ type: "uint256" }, { type: "uint16" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },

  // --- reads: your own encrypted position ----------------------------------
  // These return ciphertext handles. Decrypting one requires an EIP-712 signature and a
  // relayer round trip, and only the owner of the slot can do it.
  {
    type: "function",
    name: "balanceHandle",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "weightHandle",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  { type: "function", name: "totalHandle", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },

  // --- writes ---------------------------------------------------------------
  // Computing an encrypted value is a transaction, not a call: FHE operations mutate
  // coprocessor state. So reading your own balance is refresh-then-decrypt.
  { type: "function", name: "refreshMyBalance", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "refreshMyWeight", inputs: [], outputs: [], stateMutability: "nonpayable" },
  // Balance and odds in one transaction, so revealing your position costs a signature
  // and a single wallet prompt rather than three.
  { type: "function", name: "refreshMyPosition", inputs: [], outputs: [], stateMutability: "nonpayable" },
  // Anyone may run this. It publishes one bit: is every deposit still backed?
  { type: "function", name: "proveSolvency", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "solvencyHandle", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "solvencyProvenAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "refreshTotal", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "depositUnderlying",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "checkClaim",
    inputs: [
      { name: "drawId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // --- events ---------------------------------------------------------------
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "slot", type: "uint16", indexed: true },
    ],
  },
  {
    type: "event",
    name: "DrawSettled",
    inputs: [
      { name: "drawId", type: "uint256", indexed: true },
      { name: "total", type: "uint64", indexed: false },
      { name: "prize", type: "uint64", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;
