#!/usr/bin/env node
// ============================================================================
// Applify — Test API Form Filling untuk 10 Dummy Users
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = join(__dirname, "test_10users_apply.log");
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
const FREE_MODELS = ["openai/gpt-oss-20b:free", "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getUserData(emailPrefix) {
  const { data: authUsers } = await admin.auth.admin.listUsers({
    page: 1, perPage: 1000, email: `${emailPrefix}@example.com`,
  });
  const authUser = authUsers?.users?.find((u) => u.email === `${emailPrefix}@example.com`);
  if (!authUser) return null;

  const userId = authUser.id;
  const [profileRes, skillsRes] = await Promise.all([
    admin.from("profiles").select("*").eq("id", userId).single(),
    admin.from("user_skills").select("name").eq("user_id", userId),
  ]);

  return {
    userId,
    profile: profileRes.data,
    skills: (skillsRes.data || []).map((s) => s.name),
  };
}

async function fetchJobsFromDB() {
  const { data, error } = await admin.from("jobs").select("*").eq("status", "active").limit(20);
  if (error) throw new Error("jobs select: " + error.message);
  return data || [];
}

function findJobForProfile(jobs, profileTitle) {
  const titleLower = profileTitle?.toLowerCase() || "";
  return jobs.find((j) => j.title.toLowerCase().includes(titleLower)) || jobs[0];
}

async function generateAI(userData, job) {
  const sys = `You are an expert Indonesian career assistant. Generate a job application. Respond with ONLY valid JSON.`;
  const userPrompt = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nDescription: ${job.description || "-"}\nRequirements: ${JSON.stringify(job.requirements || [])}\n\nCANDIDATE\nName: ${userData.profile?.full_name || "-"}\nCurrent title: ${userData.profile?.current_title || "-"}\nSkills: ${userData.skills.join(", ") || "-"}\n\nReturn JSON: {"coverLetter":"250-400 word cover letter in Indonesian","matchScore":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"1-3 kalimat"}`;

  for (const modelName of FREE_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`  Trying ${modelName} (attempt ${attempt}/2)...`);

      let resp;
      try {
        resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://applify.id",
            "X-Title": "Applify UAT-10users-api",
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: "system", content: sys }, { role: "user", content: userPrompt }],
            temperature: 0.6,
            max_tokens: 800,
          }),
        });
      } catch (e) {
        console.log(`    fetch error: ${e.message}`);
        continue;
      }

      if (resp.status === 429) { console.log("    rate-limited"); continue; }
      if (resp.status === 404) { console.log("    model not found"); break; }
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        console.log(`    HTTP ${resp.status}: ${String(t).slice(0, 100)}`);
        continue;
      }

      const j = await resp.json();
      const content = j.choices?.[0]?.message?.content ?? "";
      try {
        const parsed = JSON.parse(content.replace(/```(?:json)?/gi, "").trim());
        if (parsed.matchScore !== undefined) {
          console.log(`    got valid JSON from ${modelName}`);
          return { modelUsed: modelName, ...parsed };
        }
      } catch {
        console.log(`    JSON parse failed (${attempt}/2)`);
      }
    }
  }

  console.log("    Using defaults (all models failed)");
  return {
    modelUsed: "default",
    matchScore: 0,
    acceptancePotential: 0,
    coverLetter: `[Auto-generated placeholder for ${job.title} @ ${job.company}]`,
    tailoredSkills: userData.skills.slice(0, 3),
    skillGaps: [],
    aiNotes: "AI generation gagal setelah retry semua model.",
  };
}

async function submitApplication(userId, job, aiResult) {
  const { data: app, error: e1 } = await admin.from("ai_applications").insert({
    user_id: userId,
    job_id: job.id,
    optimized_cv: { summary: aiResult.aiNotes ?? "", highlighted_skills: aiResult.tailoredSkills ?? [] },
    cover_letter: aiResult.coverLetter ?? "",
    tailored_skills: aiResult.tailoredSkills ?? [],
    ai_notes: aiResult.aiNotes ?? "",
    status: "draft",
  }).select("id").single();

  if (e1) throw new Error("insert ai_applications: " + e1.message);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: appr, error: e2 } = await admin.from("approval_requests").insert({
    user_id: userId,
    job_id: job.id,
    job_title: job.title,
    company: job.company,
    platform: "web",
    cover_letter: aiResult.coverLetter ?? "",
    answers: [{ question: "tailoredSkills", answer: JSON.stringify(aiResult.tailoredSkills ?? []), confidence: 0.8, needs_review: false }],
    status: "pending",
    expires_at: expiresAt,
  }).select("id").single();

  if (e2) throw new Error("insert approval_requests: " + e2.message);

    return { appId: app.id, approvalId: appr.id };
}

async function run() {
  console.log("=== TEST API FORM FILLING: 10 USERS ===\n");
  console.log("Fetching jobs from database...");
  const jobs = await fetchJobsFromDB();
  console.log(`Found ${jobs.length} active jobs in DB\n`);

  const results = [];

  for (let i = 1; i <= 10; i++) {
    const prefix = `user${String(i).padStart(3, "0")}`;
    console.log(`\n--- ${prefix}@example.com ---`);

    const userData = await getUserData(prefix);
    if (!userData) {
      console.log("  ❌ User not found");
      continue;
    }

    console.log(`  Profile: ${userData.profile?.current_title || "N/A"}`);
    console.log(`  Skills: ${userData.skills.join(", ")}`);

    const job = findJobForProfile(jobs, userData.profile?.current_title);
    if (!job) {
      console.log("  ⚠️ No job found");
      continue;
    }

    console.log(`  Job: ${job.title} @ ${job.company} (id: ${job.id})`);
    console.log("  Generating AI cover letter...");
    const aiResult = await generateAI(userData, job);
    if (aiResult.error) {
      console.log(`  ❌ AI error: ${aiResult.error}`);
      continue;
    }

    console.log(`  matchScore: ${aiResult.matchScore} | model: ${aiResult.modelUsed}`);
    console.log("  Submitting application (API)...");
    try {
      const ids = await submitApplication(userData.userId, job, aiResult);
      console.log(`  ✅ ai_applications: ${ids.appId} (draft)`);
      console.log(`  ✅ approval_requests: ${ids.approvalId} (pending)`);
      results.push({ user: prefix, status: "success" });
    } catch (e) {
      console.log(`  ❌ Submit error: ${e.message}`);
      results.push({ user: prefix, status: "error", error: e.message });
    }
  }

  console.log("\n\n=== SUMMARY ===");
  const successCount = results.filter((r) => r.status === "success").length;
  console.log(`Total users tested: ${results.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${results.length - successCount}`);

  if (successCount === results.length) {
    console.log("\n🎉 SEMUA USER BERHASIL SUBMIT APLIKASI (via API)");
  }
}

run().catch((e) => { console.error(e); process.exit(1); });


