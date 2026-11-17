#!/usr/bin/env node
// UJI 1 USER — "lihat apa yang terjadi".
// Mensimulasikan edge function generate-application utk 1 user (Rizky, Frontend)
// vs 1 lowongan (Gojek). Memakai kunci dari project/worker/.env.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ENV_PATH = join(__dirname, "..", "worker", ".env");

function loadEnv(p) {
  const o = {};
  for (const ln of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = ln.match(/^([A-Z_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return o;
}
const env = loadEnv(WORKER_ENV_PATH);
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
const FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
  "google/gemma-4-26b-a4b-it:free",
  "cohere/north-mini-code:free",
  "inclusionai/ling-3.0-flash:free",
];

console.log("=== ENV (dari worker/.env) ===");
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SERVICE_ROLE len:", (SERVICE_ROLE || "").length, "prefix:", (SERVICE_ROLE || "").slice(0, 6) + "...");
console.log("OPENROUTER len:", (OPENROUTER_API_KEY || "").length, "prefix:", (OPENROUTER_API_KEY || "").slice(0, 6) + "...");
console.log("");

// Data 1 user (Rizky) + 1 job (Gojek)
const profile = { full_name: "Rizky Pratama", current_title: "Frontend Engineer", experience_years: 5, skills: ["React","TypeScript","TanStack","PWA","Testing"] };
const work = [{ role_title: "Senior Frontend Engineer", company_name: "PT Fintech Maju Indonesia", description: "React + TanStack + PWA untuk 2 juta MAU; LCP 3.4s->1.1s." }];
const job = { title: "Senior Frontend Engineer", company: "Gojek", location: "Jakarta", description: "Membangun & memimpin frontend Gojek (React, TypeScript, performa tinggi). Fokus Core Web Vitals & arsitektur skalabel.", requirements: ["5+ tahun React/TypeScript","Skalabilitas frontend","Core Web Vitals","Kepemimpinan teknis"] };
const tone = "professional";

async function checkSupabase() {
  if (!SUPABASE_URL || !SERVICE_ROLE || SERVICE_ROLE.length < 20) { console.log("A) SUPABASE: service role key kosong/placeholder -> lewati tes DB."); return; }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data, error } = await admin.from("jobs").select("id").limit(1);
  if (error) {
    console.log("A) SUPABASE jobs.select error:", error.message);
    if (/does not exist|schema/i.test(error.message)) console.log("   -> Schema BELUM di-apply. Jalankan schema.sql + rpc.sql di Supabase SQL Editor dulu.");
    else if (/JWT|apikey|auth|permission/i.test(error.message)) console.log("   -> Key/autentikasi bermasalah (service role key mungkin placeholder).");
    return;
  }
  console.log("A) SUPABASE OK - tabel `jobs` ada, baris minimal:", (data?.length ?? 0));
}

async function callAI() {
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 30) {
    console.log("B) OPENROUTER: key kosong/placeholder -> AI tidak bisa dipanggil.");
    console.log("   Set OPENROUTER_API_KEY asli di worker/.env (format 'sk-or-v1-...').");
    return;
  }
  const skillList = profile.skills.join(", ");
  const workList = work.map((w) => `- ${w.role_title} @ ${w.company_name}: ${w.description ?? ""}`).join("\n");
  const sys = `You are an expert Indonesian career assistant for "Applify". Analyze the candidate-job match and write a tailored, ATS-friendly cover letter. Respond with ONLY a valid JSON object (no markdown, no code fences).`;
  const userPrompt = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location ?? "-"}\nDescription: ${job.description ?? ""}\nRequirements: ${JSON.stringify(job.requirements ?? [])}\n\nCANDIDATE\nName: ${profile.full_name}\nCurrent title: ${profile.current_title}\nExperience years: ${profile.experience_years}\nSkills: ${skillList}\nRecent experience:\n${workList}\n\nTONE: ${tone}\n\nReturn JSON exactly in this shape:\n{"coverLetter":"250-400 word cover letter","matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"strategi 1-3 kalimat Bahasa Indonesia"}`;

  for (const model of FREE_MODELS) {
    console.log("B) Memanggil OpenRouter:", model, "...");
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://applify.id", "X-Title": "Applify UAT-1user" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userPrompt }], temperature: 0.6, max_tokens: 1600 }),
      });
    } catch (e) { console.log("   fetch error:", e.message); continue; }
    const ms = Date.now() - t0;
    console.log("   HTTP", resp.status, `(${ms}ms)`);
    if (resp.status === 429) { console.log("   -> 429 rate-limited, coba model berikutnya..."); continue; }
    if (resp.status === 404) { console.log("   -> 404 slug tidak ditemukan, coba berikutnya..."); continue; }
    if (!resp.ok) { const t = await resp.text().catch(()=> ""); console.log("   GAGAL:", String(t).slice(0,300)); if (resp.status===401){console.log("   -> 401: API key tidak valid.");return;} continue; }
    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content ?? "";
    let parsed = null;
    try { parsed = JSON.parse(content.replace(/```(?:json)?/gi, "").trim()); } catch { /* ignore */ }
    console.log("\n=== HASIL AI UNTUK 1 USER (Rizky -> Gojek) ===");
    if (parsed) {
      console.log("modelUsed           :", j.model || model);
      console.log("matchScore          :", parsed.matchScore);
      console.log("acceptancePotential :", parsed.acceptancePotential);
      console.log("tailoredSkills      :", JSON.stringify(parsed.tailoredSkills));
      console.log("skillGaps           :", JSON.stringify(parsed.skillGaps));
      console.log("aiNotes             :", parsed.aiNotes);
      console.log("\n--- coverLetter ---\n" + (parsed.coverLetter || "").slice(0, 1200));
    } else {
      console.log("modelUsed:", j.model || model, "(AI tidak mengembalikan JSON valid. Raw):");
      console.log(content.slice(0, 1500));
    }
    return; // sukses / selesai setelah model pertama yang merespons
  }
  console.log("B) Semua model free kena rate-limit/gagal. Coba lagi nanti atau pakai model berbayar.");
}

(async () => {
  try { await checkSupabase(); } catch (e) { console.log("A) error:", e.message); }
  console.log("");
  try { await callAI(); } catch (e) { console.log("B) error:", e.message); }
})();

