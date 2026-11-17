#!/usr/bin/env node
// ============================================================================
// Applify — Reseed 10 Dummy User Profiles
// ============================================================================
// Hanya meng-upsert tabel `profiles` untuk user001-010
// (data skills/work/edu/settings/subscriptions sudah ada).
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = "DummyPass123!";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY dulu.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const NAMES = ["Siti","Budi","Agus","Dewi","Rizky","Putri","Andi","Rina","Yoga","Maya"];
const CITIES = ["Jakarta","Bandung","Surabaya","Yogyakarta","Semarang","Bekasi","Tangerang","Depok","Medan","Makassar"];

// Copy PROFESSIONS from seed_100_users.mjs (subset 10)
const PROFESSIONS = [
  { title: "Frontend Engineer", industry: "Teknologi", degree: "Ilmu Komputer", skills: ["React","TypeScript","CSS","JavaScript","Tailwind"], keywords: ["frontend","react","typescript","web"] },
  { title: "Backend Engineer", industry: "Teknologi", degree: "Ilmu Komputer", skills: ["Node.js","Go","PostgreSQL","Redis","Docker"], keywords: ["backend","golang","nodejs","api"] },
  { title: "Full-Stack Developer", industry: "Teknologi", degree: "Teknik Informatika", skills: ["JavaScript","React","Node.js","MongoDB","Docker"], keywords: ["full-stack","web developer","javascript"] },
  { title: "Data Scientist", industry: "Data & AI", degree: "Statistika", skills: ["Python","Machine Learning","SQL","Pandas","Statistics"], keywords: ["data scientist","machine learning","python"] },
  { title: "Data Analyst", industry: "Data & AI", degree: "Manajemen Informatika", skills: ["SQL","Excel","Tableau","Python","Power BI"], keywords: ["data analyst","sql","business intelligence"] },
  { title: "DevOps Engineer", industry: "Teknologi", degree: "Teknik Informatika", skills: ["Docker","Kubernetes","AWS","CI/CD","Terraform"], keywords: ["devops","kubernetes","aws"] },
  { title: "Cybersecurity Analyst", industry: "Keamanan Siber", degree: "Informatika", skills: ["OSINT","Ethical Hacking","Network Security","SIEM","Python"], keywords: ["cybersecurity","ethical hacking","siem"] },
  { title: "Cloud Architect", industry: "Teknologi", degree: "Teknik Informatika", skills: ["AWS","Azure","GCP","Microservices","Terraform"], keywords: ["cloud","aws","azure","gcp"] },
  { title: "Mobile Developer", industry: "Teknologi", degree: "Informatika", skills: ["Flutter","React Native","Swift","Kotlin","REST API"], keywords: ["mobile","flutter","react native"] },
  { title: "QA Engineer", industry: "Teknologi", degree: "Informatika", skills: ["Automation Testing","Jest","CI/CD","Selenium","Playwright"], keywords: ["qa","testing","automation"] },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function reseed() {
  console.log("Meng-upsert profiles untuk 10 dummy user...\n");
  let ok = 0, fail = 0;

  for (let i = 0; i < 10; i++) {
    const email = `user${String(i + 1).padStart(3, '0')}@example.com`;
    const name = NAMES[i];
    const city = CITIES[i];
    const prof = PROFESSIONS[i];

    // Cari auth user
    const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000, email });
    const authUser = authUsers?.users?.find(u => u.email === email);
    if (!authUser) {
      console.warn(`skip ${email}: Auth user tidak ditemukan`);
      fail++;
      continue;
    }

    const userId = authUser.id;
    const skills = prof.skills;

    // Upsert profiles — use ONLY columns that exist in LIVE DB
    // (live DB differs from canonical schema.sql: has skills/preferred_platforms/resume_url, but NOT headline/summary)
    const { error: profileError } = await admin.from("profiles").upsert({
      id: userId,
      full_name: name,
      current_title: prof.title,
      experience_years: 2 + Math.floor(Math.random() * 8),
      location: city,
      phone: `0812-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`,
      linkedin_url: `https://linkedin.com/in/${name.toLowerCase().replace(/ /g, "-")}`,
      portfolio_url: `https://${name.toLowerCase().replace(/ /g, "")}.github.io`,
      resume_url: `https://example.com/resume/${email.split('@')[0]}.pdf`,
      skills: skills,
      preferred_platforms: ["LinkedIn", "JobStreet", "Kalibrr"],
      avatar_url: null,
    }, { onConflict: "id" });

    if (profileError) {
      console.warn(`  profiles ${email}: ${profileError.message}`);
      fail++;
    } else {
      console.log(`  profiles ${email}: OK (${prof.title})`);
      ok++;
    }

    // Upsert user_automation_settings (pastikan ada)
    // Cek dulu apakah row sudah ada
    const { data: existingSettings } = await admin.from("user_automation_settings").select("*").eq("user_id", userId).maybeSingle();
    if (existingSettings) {
      const { error: settingsError } = await admin.from("user_automation_settings").update({
        first_name: name.split(" ")[0],
        last_name: name.split(" ").slice(1).join(" ") || name,
        current_city: city,
        country: "Indonesia",
        search_location: "Indonesia",
        search_keywords: prof.keywords || [prof.title.toLowerCase()],
        desired_salary: 5000000 + Math.floor(Math.random() * 13) * 1000000,
        notice_period: 30,
        pause_before_submit: true,
        ai_provider: "openrouter",
        ai_model: "openai/gpt-oss-20b:free",
      }).eq("user_id", userId);
      if (settingsError) {
        console.warn(`  settings ${email}: ${settingsError.message}`);
      }
    } else {
      const { error: settingsError } = await admin.from("user_automation_settings").insert({
        user_id: userId,
        first_name: name.split(" ")[0],
        last_name: name.split(" ").slice(1).join(" ") || name,
        current_city: city,
        country: "Indonesia",
        search_location: "Indonesia",
        search_keywords: prof.keywords || [prof.title.toLowerCase()],
        desired_salary: 5000000 + Math.floor(Math.random() * 13) * 1000000,
        notice_period: 30,
        pause_before_submit: true,
        ai_provider: "openrouter",
        ai_model: "openai/gpt-oss-20b:free",
      });
      if (settingsError) {
        console.warn(`  settings ${email}: ${settingsError.message}`);
      }
    }
  }

  console.log(`\nSelesai. OK: ${ok}, FAIL: ${fail}`);
}

reseed().catch(e => { console.error(e); process.exit(1); });
