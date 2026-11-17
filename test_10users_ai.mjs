#!/usr/bin/env node
// ============================================================================
// Applify — Test AI Matching untuk 10 Dummy Users
// ============================================================================
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
const FREE_MODEL = "openai/gpt-oss-20b:free";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const JOB_POOL = [
  { id: "j1", title: "Frontend Engineer", company: "Tokopedia", requirements: ["React","TypeScript","Tailwind"], keywords: ["frontend","react"] },
  { id: "j2", title: "Backend Engineer", company: "Gojek", requirements: ["Go","Node.js","PostgreSQL","Redis"], keywords: ["backend","golang","api"] },
  { id: "j3", title: "Full-Stack Developer", company: "Traveloka", requirements: ["JavaScript","React","Node.js","MongoDB"], keywords: ["full-stack","web"] },
  { id: "j4", title: "Data Scientist", company: "Bukalapak", requirements: ["Python","Machine Learning","SQL"], keywords: ["data scientist","python"] },
  { id: "j5", title: "Data Analyst", company: "Shopee", requirements: ["SQL","Excel","Tableau"], keywords: ["data analyst","sql"] },
  { id: "j6", title: "DevOps Engineer", company: "Grab", requirements: ["Docker","Kubernetes","AWS","CI/CD"], keywords: ["devops","kubernetes"] },
  { id: "j7", title: "Cybersecurity Analyst", company: "Bank BCA", requirements: ["OSINT","Ethical Hacking","SIEM"], keywords: ["cybersecurity","siem"] },
  { id: "j8", title: "Cloud Architect", company: "Telkom Indonesia", requirements: ["AWS","Azure","GCP","Microservices"], keywords: ["cloud","aws"] },
  { id: "j9", title: "Mobile Developer", company: "Gojek", requirements: ["Flutter","React Native","Kotlin"], keywords: ["mobile","flutter"] },
  { id: "j10", title: "QA Engineer", company: "Tokopedia", requirements: ["Selenium","Playwright","Jest"], keywords: ["qa","testing"] },
];

const USER_JOB_MAPPING = {
  user001: { relevant: "j1", irrelevant: "j7" },
  user002: { relevant: "j2", irrelevant: "j5" },
  user003: { relevant: "j3", irrelevant: "j4" },
  user004: { relevant: "j4", irrelevant: "j9" },
  user005: { relevant: "j5", irrelevant: "j2" },
  user006: { relevant: "j6", irrelevant: "j1" },
  user007: { relevant: "j7", irrelevant: "j3" },
  user008: { relevant: "j8", irrelevant: "j5" },
  user009: { relevant: "j9", irrelevant: "j6" },
  user010: { relevant: "j10", irrelevant: "j4" },
};
async function getUserData(emailPrefix) {
  const { data: authUsers } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
    email: `${emailPrefix}@example.com`,
  });
  const authUser = authUsers?.users?.find((u) => u.email === `${emailPrefix}@example.com`);
  if (!authUser) return null;

  const userId = authUser.id;

  const [profileRes, workRes, eduRes, skillsRes] = await Promise.all([
    admin.from("profiles").select("*").eq("id", userId).single(),
    admin.from("work_experiences").select("*").eq("user_id", userId),
    admin.from("education").select("*").eq("user_id", userId),
    admin.from("user_skills").select("*").eq("user_id", userId),
  ]);

  return {
    email: `${emailPrefix}@example.com`,
    profile: profileRes.data,
    work: workRes.data || [],
    education: eduRes.data || [],
    skills: (skillsRes.data || []).map((s) => s.name),
  };
}
async function callAI(userData, job) {
  const sys = `You are an expert Indonesian career assistant. Analyze candidate-job match. Respond with ONLY valid JSON.`;
  const userPrompt = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nDescription: ${job.description}\nRequirements: ${JSON.stringify(job.requirements)}\n\nCANDIDATE\nName: ${userData.profile?.full_name || "-"}\nCurrent title: ${userData.profile?.current_title || "-"}\nExperience years: ${userData.profile?.experience_years || 0}\nSkills: ${userData.skills.join(", ") || "-"}\n\nReturn JSON: {"matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"1-3 kalimat Bahasa Indonesia"}`;

  const t0 = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://applify.id",
      "X-Title": "Applify UAT-10users",
    },
    body: JSON.stringify({
      model: FREE_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 800,
    }),
  });

  const ms = Date.now() - t0;
  if (resp.status === 429) return { error: "rate-limited" };
  if (resp.status === 404) return { error: "model not found" };
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { error: `HTTP ${resp.status}: ${String(t).slice(0, 200)}` };
  }

  const j = await resp.json();
  const content = j.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(content.replace(/```(?:json)?/gi, "").trim());
    return { modelUsed: j.model || FREE_MODEL, latencyMs: ms, ...parsed };
  } catch {
    return { modelUsed: j.model || FREE_MODEL, latencyMs: ms, raw: content.slice(0, 500) };
  }
}
async function run() {
  console.log("=== TEST AI MATCHING: 10 USERS ===\n");
  const results = [];

  for (let i = 1; i <= 10; i++) {
    const prefix = `user${String(i).padStart(3, "0")}`;
    console.log(`\n--- ${prefix}@example.com ---`);

    const userData = await getUserData(prefix);
    if (!userData) {
      console.log("  ? User not found");
      continue;
    }

    console.log(`  Profile: ${userData.profile?.current_title || "N/A"}`);
    console.log(`  Skills: ${userData.skills.join(", ")}`);

    const mapping = USER_JOB_MAPPING[prefix];
    if (!mapping) {
      console.log("  ?? No job mapping");
      continue;
    }

    const relevantJob = JOB_POOL.find((j) => j.id === mapping.relevant);
    const irrelevantJob = JOB_POOL.find((j) => j.id === mapping.irrelevant);

    console.log(`  Testing RELEVANT job: ${relevantJob.title} @ ${relevantJob.company}`);
    const relevantResult = await callAI(userData, relevantJob);
    console.log(`    matchScore: ${relevantResult.matchScore ?? "ERROR"} (${relevantResult.latencyMs}ms)`);

    console.log(`  Testing IRRELEVANT job: ${irrelevantJob.title} @ ${irrelevantJob.company}`);
    const irrelevantResult = await callAI(userData, irrelevantJob);
    console.log(`    matchScore: ${irrelevantResult.matchScore ?? "ERROR"} (${irrelevantResult.latencyMs}ms)`);

    results.push({
      user: prefix,
      profile: userData.profile?.current_title,
      relevantJob: `${relevantJob.title} @ ${relevantJob.company}`,
      relevantScore: relevantResult.matchScore,
      irrelevantJob: `${irrelevantJob.title} @ ${irrelevantJob.company}`,
      irrelevantScore: irrelevantResult.matchScore,
    });
  }

  // Summary table
  console.log("\n\n=== SUMMARY TABLE ===");
  console.log("User            | Profile           | Relevant Job                    | Rel Score | Irrelevant Job                 | Irrel Score");
  console.log("----------------|-------------------|---------------------------------|-----------|--------------------------------|------------");
  for (const r of results) {
    const pad = (s, n) => String(s ?? "-").slice(0, n).padEnd(n);
    console.log(`${pad(r.user, 15)} | ${pad(r.profile, 17)} | ${pad(r.relevantJob, 30)} | ${pad(r.relevantScore, 9)} | ${pad(r.irrelevantJob, 29)} | ${r.irrelevantScore}`);
  }

  // Validation
  console.log("\n=== VALIDATION ===");
  let passCount = 0;
  for (const r of results) {
    if (typeof r.relevantScore === "number" && typeof r.irrelevantScore === "number") {
      if (r.relevantScore > r.irrelevantScore) {
        console.log(`  ? ${r.user}: relevant (${r.relevantScore}) > irrelevant (${r.irrelevantScore})`);
        passCount++;
      } else {
        console.log(`  ? ${r.user}: relevant (${r.relevantScore}) <= irrelevant (${r.irrelevantScore})`);
      }
    } else {
      console.log(`  ?? ${r.user}: missing scores`);
    }
  }
  console.log(`\nPassed: ${passCount}/${results.length}`);
}
retryFailedUsers().catch((e) => {
  console.error(e);
  process.exit(1);
});
async function retryFailedUsers() {
  console.log("=== RETRY FAILED USERS WITH ALTERNATIVE MODELS ===\n");
  
  const alternativeModels = [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
    "inclusionai/ling-3.0-flash:free",
  ];

  // User 008: Cloud Architect
  console.log("--- Retrying user008 (Cloud Architect) ---");
  const user008 = await getUserData("user008");
  const cloudJob = JOB_POOL.find(j => j.id === "j8");
  const dataAnalystJob = JOB_POOL.find(j => j.id === "j5");
  
  for (const model of alternativeModels) {
    console.log(`\nTrying model: ${model}`);
    const result = await callAIWithModel(user008, cloudJob, model);
    if (result.matchScore !== undefined) {
      console.log(`  ? Cloud Architect @ Telkom: ${result.matchScore} (${result.latencyMs}ms)`);
      break;
    } else {
      console.log(`  ? Error: ${result.error}`);
    }
  }
  
  // User 010: QA Engineer
  console.log("\n--- Retrying user010 (QA Engineer) ---");
  const user010 = await getUserData("user010");
  const qaJob = JOB_POOL.find(j => j.id === "j10");
  
  for (const model of alternativeModels) {
    console.log(`\nTrying model: ${model}`);
    const result = await callAIWithModel(user010, qaJob, model);
    if (result.matchScore !== undefined) {
      console.log(`  ? QA Engineer @ Tokopedia: ${result.matchScore} (${result.latencyMs}ms)`);
      break;
    } else {
      console.log(`  ? Error: ${result.error}`);
    }
  }
}
async function callAIWithModel(userData, job, model) {
  const sys = `You are an expert Indonesian career assistant. Analyze candidate-job match. Respond with ONLY valid JSON.`;
  const userPrompt = `JOB\nTitle: ${job.title}\nCompany: ${job.company}\nRequirements: ${JSON.stringify(job.requirements)}\n\nCANDIDATE\nName: ${userData.profile?.full_name || "-"}\nCurrent title: ${userData.profile?.current_title || "-"}\nSkills: ${userData.skills.join(", ") || "-"}\n\nReturn JSON: {"matchScore":0-100,"acceptancePotential":0-100,"tailoredSkills":["..."],"skillGaps":["..."],"aiNotes":"1-3 kalimat Bahasa Indonesia"}`;

  const t0 = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://applify.id",
      "X-Title": "Applify UAT-retry",
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 800,
    }),
  });

  const ms = Date.now() - t0;
  if (resp.status === 429) return { error: "rate-limited" };
  if (resp.status === 404) return { error: "model not found" };
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { error: `HTTP ${resp.status}: ${String(t).slice(0, 200)}` };
  }

  const j = await resp.json();
  const content = j.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(content.replace(/```(?:json)?/gi, "").trim());
    return { modelUsed: j.model || model, latencyMs: ms, ...parsed };
  } catch {
    return { modelUsed: j.model || model, latencyMs: ms, raw: content.slice(0, 500) };
  }
}
