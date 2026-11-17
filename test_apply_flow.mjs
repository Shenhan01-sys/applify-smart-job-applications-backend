#!/usr/bin/env node
// Phase 3 Langkah 1 — Uji alur end-to-end TANPA browser (hemat RAM).
//   public.jobs -> baca profil -> AI draf -> simpan ai_applications(draft) + approval_requests(pending/HITL)
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = join(__dirname, "phase3_stage.log");
// Tulis semua console.log juga ke file (supaya terlihat walau proses di-timeout)
const __origLog = console.log.bind(console);
console.log = (...a) => { __origLog(...a); try { appendFileSync(STAGE, a.map(String).join(" ") + "\n"); } catch {} };
function loadEnv(p) {
  const o = {};
  for (const ln of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = ln.match(/^([A-Z_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return o;
}
const env = loadEnv(join(__dirname, "..", "worker", ".env"));
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
const FREE_MODELS = ["openai/gpt-oss-20b:free","google/gemma-4-31b-it:free","google/gemma-4-26b-a4b-it:free","cohere/north-mini-code:free","inclusionai/ling-3.0-flash:free"];

if (!SUPABASE_URL || !SERVICE_ROLE || SERVICE_ROLE.length < 20) {
  console.error("SUPABASE service role key kosong/placeholder di worker/.env"); process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Fallback profil bila tabel profiles kosong (user belum di-seed)
const FALLBACK_PROFILE = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Rizky Pratama", current_title: "Frontend Engineer", experience_years: 5,
  skills: ["React","TypeScript","TanStack","PWA","Testing"],
};
const FALLBACK_WORK = [{ role_title: "Senior Frontend Engineer", company_name: "PT Fintech Maju Indonesia", description: "React + TanStack + PWA untuk 2 juta MAU; LCP 3.4s->1.1s." }];

async function fetchJob() {
  const { data, error } = await admin.from("jobs").select("*").eq("status","active").limit(5);
  if (error) throw new Error("jobs.select: " + error.message);
  if (!data || data.length === 0) throw new Error("Tidak ada job aktif di public.jobs. Jalankan seed_100_users.mjs atau insert job manual.");
  return data[0];
}

async function fetchProfile() {
  // Coba profil asli + skill + work_experiences
  const { data: prof } = await admin.from("profiles").select("*").limit(1);
  if (prof && prof.length > 0) {
    const p = prof[0];
    const [{ data: skills }, { data: work }] = await Promise.all([
      admin.from("user_skills").select("name").eq("user_id", p.id).limit(10),
      admin.from("work_experiences").select("role_title,company_name,description").eq("user_id", p.id).limit(3),
    ]);
    return {
      id: p.id,
      full_name: p.full_name, current_title: p.current_title, experience_years: p.experience_years,
      skills: (skills || []).map((s) => s.name),
      work: work || [],
      isReal: true,
    };
  }
  return { ...FALLBACK_PROFILE, work: FALLBACK_WORK, isReal: false };
}

async function ensureUser() {
  const { data: prof } = await admin.from("profiles").select("*").limit(1);
  if (prof && prof.length > 0) {
    const p = prof[0];
    const [{ data: skills }, { data: work }] = await Promise.all([
      admin.from("user_skills").select("name").eq("user_id", p.id).limit(10),
      admin.from("work_experiences").select("role_title,company_name,description").eq("user_id", p.id).limit(3),
    ]);
    return { id: p.id, full_name: p.full_name, current_title: p.current_title, experience_years: p.experience_years, skills: (skills||[]).map(s=>s.name), work: work||[], isReal: true, source: "existing profile" };
  }
  // Buat test user (FK ai_applications.user_id -> auth.users butuh user asli)
  // Email unik per-run agar createUser selalu sukses (tanpa listUsers yang lambat).
  const email = `test_apply_flow_${Date.now()}@example.com`;
  const { data: created } = await admin.auth.admin.createUser({ email, password: "TestPass123!", email_confirm: true, user_metadata: { full_name: "Rizky Pratama" } });
  if (!created?.user) throw new Error("Gagal membuat test user");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, full_name: "Rizky Pratama", current_title: "Frontend Engineer", experience_years: 5, location: "Jakarta" });
  await admin.from("user_skills").delete().eq("user_id", userId);
  for (const s of ["React","TypeScript","TanStack","PWA","Testing"]) {
    await admin.from("user_skills").insert({ user_id: userId, name: s, category: "technical", proficiency_level: 4 });
  }
  return { id: userId, full_name: "Rizky Pratama", current_title: "Frontend Engineer", experience_years: 5, skills: ["React","TypeScript","TanStack","PWA","Testing"], work: FALLBACK_WORK, isReal: true, source: "new test user" };
}

function buildPrompt(profile, job) {
  const skillList = (profile.skills || []).join(", ");
  const workList = (profile.work || []).map((w) => `- ${w.role_title} @ ${w.company_name}: ${w.description ?? ""}`).join("\n");
  const sys = `You are an expert Indonesian career assistant for "Applify". Analyze the candidate-job match and write a tailored, ATS-friendly cover letter. Respond with ONLY a valid JSON object (no markdown, no code fences).`;
  const userPrompt = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location ?? "-"}\nDescription: ${job.description ?? ""}\nRequirements: ${JSON.stringify(job.requirements ?? [])}\n\nCANDIDATE\nName: ${profile.full_name}\nCurrent title: ${profile.current_title}\nExperience years: ${profile.experience_years}\nSkills: ${skillList}\nRecent experience:\n${workList}\n\nTONE: professional\n\nReturn JSON exactly in this shape:\n{"coverLetter":"250-400 word cover letter","matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"strategi 1-3 kalimat Bahasa Indonesia"}`;
  return { sys, userPrompt };
}

async function callAI(profile, job) {
  const { sys, userPrompt } = buildPrompt(profile, job);
  for (const model of FREE_MODELS) {
    process.stdout.write("  AI " + model + " ... ");
    const t0 = Date.now();
    let resp;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000); // hindari hang
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://applify.id", "X-Title": "Applify Phase3" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userPrompt }], temperature: 0.6, max_tokens: 1600 }),
        signal: ctrl.signal,
      });
      clearTimeout(to);
    } catch (e) { console.error("   fetch abort:", e.name, e.message); continue; }
    const ms = Date.now() - t0;
    console.log("HTTP " + resp.status + " (" + ms + "ms)");
    if (resp.status === 429 || resp.status === 404) continue;
    if (!resp.ok) { const t = await resp.text().catch(()=> ""); console.log("   GAGAL:", String(t).slice(0,200)); if (resp.status===401) return null; continue; }
    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content ?? "";
    let parsed = null;
    try { parsed = JSON.parse(content.replace(/```(?:json)?/gi, "").trim()); } catch { /* ignore */ }
    return { parsed, raw: content, modelUsed: j.model || model, ms };
  }
  return null;
}

async function persist(userId, job, parsed, modelUsed, ms) {
  // 1) Simpan draf AI
  const { data: app, error: e1 } = await admin.from("ai_applications").insert({
    user_id: userId,
    job_id: job.id,
    optimized_cv: { summary: parsed.aiNotes ?? "", highlighted_skills: parsed.tailoredSkills ?? [] },
    cover_letter: parsed.coverLetter ?? "",
    tailored_skills: parsed.tailoredSkills ?? [],
    ai_notes: parsed.aiNotes ?? "",
    status: "draft",
  }).select("id").single();
  if (e1) throw new Error("insert ai_applications: " + e1.message);

  // 2) Buat antrian HITL (approval_requests) - berlaku 1 jam
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: appr, error: e2 } = await admin.from("approval_requests").insert({
    user_id: userId,
    job_id: job.id,
    job_title: job.title,
    company: job.company,
    platform: job.platform_source ?? "web",
    cover_letter: parsed.coverLetter ?? "",
    answers: [{ question: "tailoredSkills", answer: JSON.stringify(parsed.tailoredSkills ?? []), confidence: 0.8, needs_review: false }],
    status: "pending",
    expires_at: expiresAt,
  }).select("id").single();
  if (e2) throw new Error("insert approval_requests: " + e2.message);

  return { appId: app.id, approvalId: appr.id };
}

(async () => {
  console.log("=== Phase 3 Langkah 1: alur end-to-end (TANPA browser) ===\n");
  console.log("1) Ambil user...");
  const u = await ensureUser();
  console.log("   user:", u.full_name, "| id:", u.id, "| source:", u.source, "| skills:", JSON.stringify(u.skills));

  console.log("\n2) Ambil job dari public.jobs...");
  const job = await fetchJob();
  console.log("   job:", job.title, "@", job.company, "| id:", job.id, "| platform:", job.platform_source);

  console.log("\n3) AI buat draf (OpenRouter)...");
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 30) { console.log("   OPENROUTER key kosong -> skip AI. Set di worker/.env."); return; }
  const ai = await callAI(u, job);
  if (!ai) { console.log("   Semua model free gagal/rate-limit. Coba lagi nanti."); return; }
  console.log("   modelUsed:", ai.modelUsed, "| waktu:", ai.ms + "ms");
  if (!ai.parsed) { console.log("   AI tidak mengembalikan JSON valid. Raw:\n" + ai.raw.slice(0, 800)); return; }
  console.log("   matchScore:", ai.parsed.matchScore, "| acceptancePotential:", ai.parsed.acceptancePotential);
  console.log("   tailoredSkills:", JSON.stringify(ai.parsed.tailoredSkills));
  console.log("   skillGaps:", JSON.stringify(ai.parsed.skillGaps));
  console.log("   aiNotes:", ai.parsed.aiNotes);

  console.log("\n4) Simpan ke DB (ai_applications + approval_requests)...");
  try {
    const ids = await persist(u.id, job, ai.parsed, ai.modelUsed, ai.ms);
    console.log("   ✓ ai_applications id :", ids.appId, "(status: draft)");
    console.log("   ✓ approval_requests id:", ids.approvalId, "(status: pending -> HITL)");
  } catch (e) { console.log("   ✗ persist gagal:", e.message); return; }

  console.log("\n=== RINGKASAN ALUR (tanpa browser) ===");
  console.log("public.jobs -> baca profil -> AI draf -> ai_applications(draft) + approval_requests(pending)");
  console.log("Status: DRAFT + antrian review manusia (HITL). BELUM auto-apply (perlu worker+agent-browser, langkah 2-3).");
  console.log("\n--- coverLetter (potongan) ---\n" + (ai.parsed.coverLetter || "").slice(0, 900));
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });


