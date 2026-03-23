import { useState, useCallback, useEffect } from "react";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import {
  x25519, RescueCipher, getMXEPublicKey, getMXEAccAddress,
  getCompDefAccAddress, getClusterAccAddress, getComputationAccAddress,
  getMempoolAccAddress, getExecutingPoolAccAddress, getFeePoolAccAddress,
  getClockAccAddress, getCompDefAccOffset, getArciumProgramId,
  awaitComputationFinalization, deserializeLE,
} from "@arcium-hq/client";
window.Buffer = Buffer;

const PROGRAM_ID = new PublicKey("H6NrSVGXBpp5jdrEAaLHuWLsmPUhMt9yK2uujQotNmKU");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const CLUSTER_OFFSET = 456;
import IDL from "./idl/shadow_vote.json";

function randomBytes(n: number): Buffer { return Buffer.from(crypto.getRandomValues(new Uint8Array(n))); }
function toArr32(data: any): number[] { const r: number[] = []; for (let i = 0; i < 32; i++) r.push(typeof data[i] === "number" ? data[i] & 0xff : 0); return r; }
function shorten(a: string) { return a.slice(0, 6) + "..." + a.slice(-4); }

type View = "landing" | "app";
type Status = "idle" | "encrypting" | "computing" | "complete" | "error";

function getProvider() {
  const s = (window as any).solana;
  return s?.isPhantom ? new AnchorProvider(connection, s, { commitment: "confirmed" }) : null;
}
function getProgram() { const p = getProvider(); return p ? new Program(IDL as any, p) : null; }

async function getMXEPubKeyRetry(provider: AnchorProvider, pid: PublicKey, retries = 5): Promise<Uint8Array> {
  for (let i = 0; i < retries; i++) {
    try { const k = await getMXEPublicKey(provider, pid); if (k) return k; } catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error("Failed to get MXE key");
}

export default function App() {
  const [view, setView] = useState<View>("landing");
  const [wallet, setWallet] = useState("");
  const [connected, setConnected] = useState(false);
  const [balance, setBalance] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [chainMsg, setChainMsg] = useState("");
  const [txSigs, setTxSigs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [voteResult, setVoteResult] = useState<{success: boolean; txSig: string} | null>(null);
  const [selectedOption, setSelectedOption] = useState(0);

  const connect = useCallback(async () => {
    try {
      const s = (window as any).solana;
      if (!s?.isPhantom) { alert("Install Phantom wallet — Devnet"); return; }
      const r = await s.connect(); setWallet(r.publicKey.toString()); setConnected(true); setView("app");
      setBalance((await connection.getBalance(r.publicKey)) / 1e9);
    } catch {}
  }, []);

  const disconnect = useCallback(async () => {
    try { await (window as any).solana?.disconnect(); } catch {}
    setWallet(""); setConnected(false); setView("landing"); setTxSigs([]);
  }, []);

  const initOnChain = useCallback(async () => {
    const prog = getProgram(); if (!prog) return;
    setChainMsg("Initializing...");
    try {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from("program_state")], PROGRAM_ID);
      const info = await connection.getAccountInfo(pda);
      if (info) { setChainMsg("Already initialized"); }
      else {
        const tx = await prog.methods.initialize().accounts({ authority: new PublicKey(wallet), programState: pda, systemProgram: SystemProgram.programId }).rpc();
        setTxSigs(p => [...p, tx]); setChainMsg("Initialized — " + shorten(tx));
      }
    } catch (e: any) { setChainMsg(e.message?.includes("already in use") ? "Already initialized" : "Error: " + e.message?.slice(0, 60)); }
    // Init comp def
    try {
      setChainMsg("Initializing computation definition...");
      const compDefOffset = Buffer.from(getCompDefAccOffset("cast_vote")).readUInt32LE();
      const compDefAddr = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
      const compDefInfo = await connection.getAccountInfo(compDefAddr);
      if (!compDefInfo) {
        const mxeAddr = getMXEAccAddress(PROGRAM_ID);
        const arciumProgId = getArciumProgramId();
        const { getArciumProgram, getLookupTableAddress } = await import("@arcium-hq/client");
        const arcProg = getArciumProgram(provider!);
        const mxeAcc = await arcProg.account.mxeAccount.fetch(mxeAddr);
        const lutAddr = getLookupTableAddress(PROGRAM_ID, (mxeAcc as any).lutOffsetSlot);
        const LUT_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");
        const tx2 = await prog.methods.initCastVoteCompDef().accountsPartial({
          payer: new PublicKey(wallet),
          mxeAccount: mxeAddr,
          arciumProgram: arciumProgId,
          systemProgram: SystemProgram.programId,
          addressLookupTable: lutAddr,
          lutProgram: LUT_PROGRAM,
        }).rpc();
        setTxSigs(p => [...p, tx2]); setChainMsg("Comp def initialized — " + shorten(tx2));
      } else { setChainMsg("Ready — comp def exists"); }
    } catch (e2: any) { setChainMsg("Comp def: " + (e2.message?.slice(0, 60) || "error")); }
  }, [wallet]);

  const castVote = useCallback(async () => {
    const provider = getProvider();
    const prog = getProgram();
    if (!provider || !prog) { setChainMsg("Connect wallet first"); return; }

    setVoteResult(null); setErrorMsg("");
    setStatus("encrypting"); setProgress(15);
    setChainMsg("Fetching MXE x25519 public key...");

    try {
      const mxePubKey = await getMXEPubKeyRetry(provider, PROGRAM_ID);
      setProgress(25);
      setChainMsg("Encrypting vote with Rescue cipher...");

      const privKey = x25519.utils.randomPrivateKey();
      const pubKey = x25519.getPublicKey(privKey);
      const sharedSecret = x25519.getSharedSecret(privKey, mxePubKey);
      const cipher = new RescueCipher(sharedSecret as any);
      const nonce = randomBytes(16);

      const ctOptionIdx = cipher.encrypt([BigInt(selectedOption)], nonce);
      const ctWeight = cipher.encrypt([BigInt(1)], nonce);
      const ctNumOptions = cipher.encrypt([BigInt(4)], nonce);
      setProgress(45);
      setChainMsg("Vote encrypted. Queuing MPC computation on Solana...");

      const computationOffset = new BN(randomBytes(8), "hex");
      const compDefOffset = Buffer.from(getCompDefAccOffset("cast_vote")).readUInt32LE();

      setStatus("computing"); setProgress(55);
      setChainMsg("Submitting encrypted vote to Arcium MPC...");

      const queueTx = await prog.methods.castVote(
        computationOffset,
        toArr32(ctOptionIdx[0]),
        toArr32(ctWeight[0]),
        toArr32(ctNumOptions[0]),
        toArr32(pubKey),
        new BN(deserializeLE(nonce).toString()),
      ).accountsPartial({
        payer: provider.publicKey,
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
        executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
        computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
        compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefOffset),
        clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
        poolAccount: getFeePoolAccAddress(),
        clockAccount: getClockAccAddress(),
        systemProgram: SystemProgram.programId,
      }).rpc({ commitment: "confirmed" });

      setTxSigs(p => [...p, queueTx]);
      setProgress(65);
      setChainMsg("Vote queued! Tx: " + shorten(queueTx) + ". Waiting for MPC...");

      setProgress(80);
      setChainMsg("ARX nodes processing vote on secret shares...");

      const finalizeTx = await awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, "confirmed", 120000);
      setTxSigs(p => [...p, finalizeTx]);
      setProgress(100);
      setVoteResult({ success: true, txSig: finalizeTx });
      setStatus("complete");
      setChainMsg("Vote verified via MPC! Callback: " + shorten(finalizeTx));

    } catch (e: any) {
      console.error("Vote error:", e);
      setErrorMsg(e.message?.slice(0, 120) || "Unknown error");
      setStatus("error");
      setChainMsg("Error: " + (e.message?.slice(0, 80) || "Unknown"));
    }
  }, [selectedOption, wallet]);

  const reset = useCallback(() => { setStatus("idle"); setProgress(0); setVoteResult(null); setChainMsg(""); setErrorMsg(""); }, []);

  const options = ["Approve Protocol Upgrade", "Reject Protocol Upgrade", "Delay to Next Quarter", "Abstain"];

  if (view === "landing") return (
    <div style={{minHeight:"100vh",background:"#0a0a0a",color:"#e5e5e5",fontFamily:"'Inter',system-ui,sans-serif"}}>
      <nav style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 48px",maxWidth:1200,margin:"0 auto"}}>
        <div style={{fontSize:"1.25rem",fontWeight:700,letterSpacing:"-0.03em"}}>Shadow<span style={{color:"#818cf8"}}>Vote</span></div>
        <button onClick={connect} style={{background:"#818cf8",color:"#fff",border:"none",padding:"10px 24px",borderRadius:999,fontWeight:600,fontSize:"0.875rem",cursor:"pointer"}}>Launch App</button>
      </nav>
      <section style={{padding:"100px 48px",maxWidth:1200,margin:"0 auto"}}>
        <div style={{fontSize:"0.75rem",fontWeight:600,color:"#818cf8",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:20}}>PRIVATE GOVERNANCE</div>
        <h1 style={{fontSize:"clamp(2.5rem,5vw,4rem)",fontWeight:800,lineHeight:1.1,letterSpacing:"-0.03em",marginBottom:20}}>Encrypted voting<br/>on Solana.</h1>
        <p style={{fontSize:"1rem",lineHeight:1.7,color:"#888",maxWidth:500,marginBottom:36}}>Votes encrypted with Rescue cipher and tallied inside Arcium MPC. No one sees individual votes. Only final results published on-chain. Real end-to-end MPC.</p>
        <div style={{display:"flex",gap:12}}>
          <button onClick={connect} style={{background:"#818cf8",color:"#fff",border:"none",padding:"14px 32px",borderRadius:999,fontWeight:600,fontSize:"1rem",cursor:"pointer"}}>Launch App</button>
          <a href="https://github.com/tilakkumar56/shadow-vote" target="_blank" rel="noreferrer" style={{background:"transparent",color:"#e5e5e5",border:"1px solid rgba(255,255,255,0.15)",padding:"14px 32px",borderRadius:999,fontWeight:600,fontSize:"1rem",textDecoration:"none"}}>GitHub</a>
        </div>
      </section>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:20,padding:"0 48px 80px",maxWidth:1200,margin:"0 auto"}}>
        {[["Encrypted votes","Rescue cipher + x25519 ECDH. Votes never visible to anyone."],["MPC tallying","ARX nodes process votes on secret shares. No single node sees any vote."],["Real computation","Frontend triggers actual Arcium MPC. Not simulated."]].map(([t,d],i) =>
          <div key={i} style={{background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,padding:28}}>
            <div style={{fontSize:"1rem",fontWeight:700,marginBottom:8}}>{t}</div>
            <div style={{fontSize:"0.875rem",color:"#666",lineHeight:1.6}}>{d}</div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:"#0a0a0a",color:"#e5e5e5",fontFamily:"'Inter',system-ui,sans-serif"}}>
      <nav style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 48px",maxWidth:1200,margin:"0 auto"}}>
        <div style={{fontSize:"1.25rem",fontWeight:700}}>Shadow<span style={{color:"#818cf8"}}>Vote</span></div>
        <div style={{display:"flex",gap:16,alignItems:"center"}}>
          <span onClick={() => setView("landing")} style={{fontSize:"0.875rem",color:"#666",cursor:"pointer"}}>Home</span>
          <span style={{fontFamily:"monospace",fontSize:"0.75rem",color:"#666",padding:"6px 12px",background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:999}}>{shorten(wallet)}</span>
          <button onClick={disconnect} style={{background:"transparent",border:"none",color:"#666",fontSize:"0.8125rem",cursor:"pointer"}}>Disconnect</button>
        </div>
      </nav>
      <div style={{maxWidth:1200,margin:"0 auto",padding:"0 48px 60px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,marginBottom:16,fontSize:"0.8125rem",color:"#666"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#22c55e",flexShrink:0}}/> Solana Devnet — Real Arcium MPC (cluster 456)
          <span style={{fontFamily:"monospace",marginLeft:8}}>{shorten(PROGRAM_ID.toString())}</span>
          <span style={{marginLeft:"auto"}}>{balance.toFixed(2)} SOL</span>
          {status==="computing"&&<><span style={{width:8,height:8,borderRadius:"50%",background:"#818cf8",animation:"pulse 1.5s infinite"}}/>MPC Active</>}
        </div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <button onClick={initOnChain} style={{background:"#818cf8",color:"#fff",border:"none",padding:"8px 18px",borderRadius:999,fontWeight:600,fontSize:"0.75rem",cursor:"pointer",textTransform:"uppercase",letterSpacing:"0.05em"}}>Initialize</button>
          {chainMsg && <span style={{fontSize:"0.8125rem",color:"#666",alignSelf:"center",marginLeft:8}}>{chainMsg}</span>}
        </div>
        {txSigs.length > 0 && <div style={{padding:"10px 14px",background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,marginBottom:16}}>
          <div style={{fontSize:"0.625rem",fontWeight:600,color:"#818cf8",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>On-Chain Transactions</div>
          {txSigs.map((sig, i) => <a key={i} href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`} target="_blank" rel="noreferrer" style={{fontFamily:"monospace",fontSize:"0.6875rem",color:"#666",textDecoration:"none",display:"block",marginBottom:2}}>{shorten(sig)} ↗</a>)}
        </div>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          <div style={{background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,padding:24}}>
            <div style={{fontSize:"0.9375rem",fontWeight:600,marginBottom:4}}>Cast Your Vote</div>
            <div style={{fontSize:"0.8125rem",color:"#666",marginBottom:16}}>Proposal: Protocol Upgrade v2.0</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {options.map((opt, i) => (
                <div key={i} onClick={() => { setSelectedOption(i); reset(); }}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background: selectedOption === i ? "rgba(129,140,248,0.08)" : "#0a0a0a",
                    border: selectedOption === i ? "1px solid #818cf8" : "1px solid rgba(255,255,255,0.06)",borderRadius:10,cursor:"pointer",fontSize:"0.875rem",transition:"all 0.15s"}}>
                  <span style={{width:18,height:18,borderRadius:"50%",border: selectedOption === i ? "2px solid #818cf8" : "2px solid rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    {selectedOption === i && <span style={{width:8,height:8,borderRadius:"50%",background:"#818cf8"}}/>}
                  </span>
                  {opt}
                </div>
              ))}
            </div>
          </div>
          <div style={{background:"#141414",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,padding:24}}>
            <div style={{fontSize:"0.9375rem",fontWeight:600,marginBottom:4}}>MPC Verification</div>
            <div style={{fontSize:"0.8125rem",color:"#666",marginBottom:16}}>Real Arcium MPC on devnet cluster 456</div>
            {status === "idle" && !voteResult && (
              <div style={{textAlign:"center",padding:20}}>
                <div style={{fontSize:"0.8125rem",color:"#666",marginBottom:16}}>Selected: <strong style={{color:"#e5e5e5"}}>{options[selectedOption]}</strong></div>
                <div style={{fontSize:"0.75rem",color:"#555",marginBottom:16}}>This triggers real Rescue cipher encryption and Arcium MPC computation</div>
                <button onClick={castVote} style={{width:"100%",background:"#818cf8",color:"#fff",border:"none",padding:"12px 24px",borderRadius:999,fontWeight:600,fontSize:"0.875rem",cursor:"pointer"}}>Cast Vote via Arcium MPC</button>
              </div>
            )}
            {(status === "encrypting" || status === "computing") && (
              <div style={{padding:"12px 0"}}>
                <div style={{width:"100%",height:4,background:"rgba(255,255,255,0.06)",borderRadius:2,overflow:"hidden",margin:"12px 0"}}>
                  <div style={{height:"100%",background:"#818cf8",borderRadius:2,transition:"width 0.5s",width:`${progress}%`}}/>
                </div>
                <div style={{fontSize:"0.8125rem",color:"#666",textAlign:"center"}}>{chainMsg}</div>
              </div>
            )}
            {status === "error" && (
              <div style={{textAlign:"center",padding:20}}>
                <div style={{fontSize:"0.875rem",color:"#f87171",marginBottom:12}}>{errorMsg}</div>
                <button onClick={reset} style={{background:"transparent",color:"#e5e5e5",border:"1px solid rgba(255,255,255,0.15)",padding:"8px 18px",borderRadius:999,fontWeight:600,fontSize:"0.75rem",cursor:"pointer"}}>Try Again</button>
              </div>
            )}
            {voteResult && (
              <div style={{textAlign:"center",padding:20}}>
                <div style={{width:48,height:48,borderRadius:"50%",background:"rgba(34,197,94,0.12)",color:"#22c55e",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px",fontSize:"1.25rem"}}>✓</div>
                <div style={{background:"rgba(34,197,94,0.12)",color:"#22c55e",display:"inline-block",padding:"4px 12px",borderRadius:999,fontSize:"0.75rem",fontWeight:600,marginBottom:12}}>VOTE RECORDED VIA MPC</div>
                <div style={{fontSize:"0.8125rem",color:"#666",marginBottom:4}}>Computation finalized on-chain</div>
                <div style={{fontSize:"0.75rem",color:"#666",marginBottom:16}}>Callback: <a href={`https://explorer.solana.com/tx/${voteResult.txSig}?cluster=devnet`} target="_blank" rel="noreferrer" style={{color:"#818cf8"}}>{shorten(voteResult.txSig)} ↗</a></div>
                <button onClick={reset} style={{background:"transparent",color:"#e5e5e5",border:"1px solid rgba(255,255,255,0.15)",padding:"8px 18px",borderRadius:999,fontWeight:600,fontSize:"0.75rem",cursor:"pointer"}}>Vote Again</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </div>
  );
}
