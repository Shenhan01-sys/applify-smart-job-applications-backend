#!/usr/bin/env node
// Validasi akurasi AI MATCHING lintas profesi (tanpa DB write, cepat, hemat RAM).
// Cek: apakah AI memberi matchScore TINGGI utk pasangan yang tepat, dan RENDAH utk yang salah.
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = join(__dirname, "phase3_match.log");
const __origLog = console.log.bind(console);
console.log = (...a) => { __origLog(...a); try { appendFileSync(STAGE, a.map(String).join(" ") + "\n"); } catch {} };

function loadEnv(p) { const o={}; for(const ln of readFileSync(p,"utf8").split(/\r?\n/)){ const m=ln.match(/^([A-Z_]+)=(.*)$/); if(m) o[m[1]]=m[2].trim().replace(/^"(.*)"$/,"$1");} return o; }
const env = loadEnv(join(__dirname, "..", "worker", ".env"));
const API_KEY = env.OPENROUTER_API_KEY;
const MODELS = ["openai/gpt-oss-20b:free"];

function prompt(profile, job){
  const sys = `You are an expert Indonesian career assistant. Analyze candidate-job match. Return ONLY JSON: {"matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"1-3 kalimat Bahasa Indonesia"}`;
  const u = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nRequirements: ${JSON.stringify(job.req||[])}\n\nCANDIDATE\nTitle: ${profile.title}\nYears exp: ${profile.years}\nSkills: ${profile.skills.join(", ")}\nExperience: ${profile.exp}\n\nReturn JSON exactly in this shape:\n{"matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"..."}`;
  return { sys, user: u };
}
async function score(profile, job){
  const { sys, user } = prompt(profile, job);
  const model = MODELS[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r)=>setTimeout(r, 700));
    let resp;
    try {
      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),12000);
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${API_KEY}`,"Content-Type":"application/json","HTTP-Referer":"https://applify.id","X-Title":"Applify match-test"},body:JSON.stringify({model,messages:[{role:"system",content:sys},{role:"user",content:user}],temperature:0.2,max_tokens:700}),signal:ctrl.signal});
      clearTimeout(to);
    } catch(e){ continue; }
    if(resp.status===429||resp.status===404||!resp.ok) continue;
    const j=await resp.json(); const c=j.choices?.[0]?.message?.content??"";
    try { const p=JSON.parse(c.replace(/```(?:json)?/gi,"").trim()); return {score:p.matchScore, acc:p.acceptancePotential, model:j.model||model, skills:p.tailoredSkills}; }
    catch{ /* retry */ }
  }
  return {score:null};
}

const CASES = [
  {
    label: "Frontend Engineer → job Frontend (GOOD) vs job Akuntan (BAD)",
    profile: { title: "Frontend Engineer", years: 5, skills: ["React","TypeScript","Tailwind","JavaScript","Testing"], exp: "Membangun PWA & web app React utk 1 juta user; fokus performa & aksesibilitas." },
    goodJob: { title: "Senior Frontend Engineer", company: "Gojek", req: ["5+ tahun React/TypeScript","Core Web Vitals","arsitektur frontend skalabel"] },
    badJob:  { title: "Accountant", company: "Deloitte Indonesia", req: ["Laporan keuangan","Pajak","Audit","Excel","SAP"] },
  },
  {
    label: "Pharmacist → job Farmasi (GOOD) vs job IT (BAD)",
    profile: { title: "Pharmacist (Apoteker)", years: 4, skills: ["Farmasi","Obat-obatan","Pelayanan Resep","Farmakologi","BPOM"], exp: "Apoteker di apotek & rumah sakit; layanan resep & konseling farmasi." },
    goodJob: { title: "Pharmacist (Apoteker)", company: "Kimia Farma", req: ["S1 Farmasi + Profesi Apoteker","Pelayanan resep","Manajemen obat"] },
    badJob:  { title: "Senior Frontend Engineer", company: "Gojek", req: ["React/TypeScript","Web","Performa"] },
  },
  {
    label: "Accountant → job Akuntansi (GOOD) vs job Desain (BAD)",
    profile: { title: "Accountant", years: 6, skills: ["Akuntansi","Laporan Keuangan","Pajak","Audit","SAP"], exp: "Akuntan perusahaan; penyusunan laporan keuangan & pelaporan pajak." },
    goodJob: { title: "Accountant", company: "Deloitte Indonesia", req: ["Laporan keuangan","Pajak","Audit","Excel","SAP"] },
    badJob:  { title: "Graphic Designer", company: "Alodokter", req: ["Photoshop","Illustrator","Branding","Layout"] },
  },
];

(async () => {
  console.log("=== Validasi Akurasi AI Matching Lintas Profesi ===\n");
  let allOk = true;
  for (const c of CASES) {
    console.log("Kasus:", c.label);
    const good = await score(c.profile, c.goodJob);
    const bad = await score(c.profile, c.badJob);
    console.log(`   GOOD(tepat)    : match=${good.score??"-"} acc=${good.acc??"-"} (${good.model||"?"}) skills=${good.skills?JSON.stringify(good.skills.slice(0,5)):"-"}`);
    console.log(`   BAD(salah)     : match=${bad.score??"-"} acc=${bad.acc??"-"} (${bad.model||"?"})`);
    const ok = (good.score ?? 0) > (bad.score ?? 0);
    allOk = allOk && ok;
    console.log(`   Verdict        : ${ok ? "OK — skor TEPAT > skor SALAH ✓" : "⚠️ GAGAL diskriminasi (good<=bad)"}`);
    console.log("");
  }
  console.log("=== KESIMPULAN ===");
  console.log(allOk ? "✅ AI MATCHING AKURAT: memberi skor tinggi utk job yang relevan & rendah utk yang tidak." : "⚠️ Ada kasus di mana AI belum bisa membedakan — perlu tuning prompt/data.");
})().catch((e)=>{ console.error("FATAL:",e.message); process.exit(1); });

