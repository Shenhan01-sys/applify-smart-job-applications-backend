#!/usr/bin/env node
// ============================================================================
// Applify — Seed 100 Dummy Users (UAT) — versi "background beragam"
// ----------------------------------------------------------------------------
// Membuat 100 user autentik di Supabase Auth + profil/skill/pengalaman/edu
// /settings/sub dengan background yang BERBEDA-BEDA lintas banyak profesi,
// sehingga bisa diuji apakah agen AI benar-benar mencari kerja yang relevan
// untuk kebutuhan beragam (tech, management, business, akuntansi, bank,
// farmasi/kesehatan, content creator, dll).
//
// Data profesi disimpan di PROFESSIONS (mudah diperluas hingga ratusan jenis).
// Cara pakai sama: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, lalu
//   node seed_100_users.mjs
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = "DummyPass123!";
const USER_COUNT = Number(process.env.SEED_COUNT) || 100;
const EMAIL_DOMAIN = "example.com";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY dulu.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const NAMES = ["Budi","Siti","Agus","Dewi","Rizky","Putri","Andi","Rina","Yoga","Maya","Fajar","Laila","Dimas","Nadia","Eko","Sari","Hendra","Intan","Bagas","Citra","Fikri","Ayu","Reza","Wulan","Donny","Kirana","Rahmat","Salsa","Taufik","Gita"];
const CITIES = ["Jakarta","Bandung","Surabaya","Yogyakarta","Semarang","Bekasi","Tangerang","Depok","Medan","Makassar","Denpasar","Balikpapan","Palembang","Pekanbaru","Malang","Bogor","Solo","Samarinda","Pontianak","Mataram"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sample(arr, n) { return arr.sort(() => Math.random() - 0.5).slice(0, n); }

// ============================================================================
// KATALOG PROFESI — tambah jenis baru di sini (bisa sampai ratusan).
// skill/keywords dipakai utk men-generate background + keyword pencarian AI.
// ============================================================================
const PROFESSIONS = [
  // ---------------- TECH ----------------
  { title: "Frontend Engineer", industry: "Teknologi", degree: "Ilmu Komputer", education: ["S1 Ilmu Komputer","SMK RPL"], skills: ["React","TypeScript","CSS","JavaScript","Tailwind"], keywords: ["frontend","react","typescript","web"] },
  { title: "Backend Engineer", industry: "Teknologi", degree: "Ilmu Komputer", education: ["S1 Informatika"], skills: ["Node.js","Go","PostgreSQL","Redis","Docker"], keywords: ["backend","golang","nodejs","api"] },
  { title: "Full-Stack Developer", industry: "Teknologi", degree: "Teknik Informatika", education: ["S1 Teknik Informatika"], skills: ["JavaScript","React","Node.js","MongoDB","Docker"], keywords: ["full-stack","web developer","javascript"] },
  { title: "Data Scientist", industry: "Data & AI", degree: "Statistika", education: ["S1 Statistika","S2 Data Science"], skills: ["Python","Machine Learning","SQL","Pandas","Statistics"], keywords: ["data scientist","machine learning","python"] },
  { title: "Data Analyst", industry: "Data & AI", degree: "Manajemen Informatika", education: ["S1 Sistem Informasi"], skills: ["SQL","Excel","Tableau","Python","Power BI"], keywords: ["data analyst","sql","business intelligence"] },
  { title: "DevOps Engineer", industry: "Teknologi", degree: "Teknik Komputer", education: ["S1 Teknik Komputer"], skills: ["Docker","Kubernetes","AWS","CI/CD","Linux"], keywords: ["devops","kubernetes","aws","terraform"] },
  { title: "Cybersecurity Analyst", industry: "Keamanan Siber", degree: "Ilmu Keamanan Siber", education: ["S1 Keamanan Informasi"], skills: ["Network Security","SIEM","Python","Ethical Hacking","OSINT"], keywords: ["cybersecurity","security analyst","penetration"] },
  { title: "Cloud Architect", industry: "Teknologi", degree: "Ilmu Komputer", education: ["S1 Teknik Informatika"], skills: ["AWS","GCP","Azure","Terraform","Microservices"], keywords: ["cloud architect","aws","gcp","infrastructure"] },
  { title: "Mobile Developer", industry: "Teknologi", degree: "Ilmu Komputer", education: ["S1 Ilmu Komputer"], skills: ["Kotlin","Flutter","Swift","React Native","REST"], keywords: ["mobile developer","android","flutter","ios"] },
  { title: "QA Engineer", industry: "Teknologi", degree: "Ilmu Komputer", education: ["S1 Teknik Informatika"], skills: ["Automation Testing","Selenium","Playwright","Jest","CI/CD"], keywords: ["qa","tester","automation","quality"] },
  { title: "AI/ML Engineer", industry: "Data & AI", degree: "Ilmu Komputer / AI", education: ["S2 Kecerdasan Buatan"], skills: ["Python","TensorFlow","PyTorch","NLP","LLM"], keywords: ["machine learning engineer","ai","llm","nlp"] },
  { title: "IT Support", industry: "Teknologi", degree: "Manajemen Informatika", education: ["D3 Teknik Informatika"], skills: ["Windows","Networking","Troubleshooting","Active Directory","Hardware"], keywords: ["it support","technical support","helpdesk"] },

  // ---------------- MANAGEMENT ----------------
  { title: "Project Manager", industry: "Manajemen", degree: "Manajemen", education: ["S1 Manajemen","S1 Teknik Industri"], skills: ["Project Planning","Agile","Scrum","Risk Management","Stakeholder"], keywords: ["project manager","agile","scrum","project"] },
  { title: "Product Manager", industry: "Teknologi", degree: "Manajemen / Komputer", education: ["S1 Manajemen","S1 Sistem Informasi"], skills: ["Product Strategy","User Research","Roadmapping","Analytics","A/B Testing"], keywords: ["product manager","product","roadmap"] },
  { title: "Operations Manager", industry: "Operasional", degree: "Manajemen Operasi", education: ["S1 Manajemen"], skills: ["Process Optimization","Supply Chain","Budgeting","Lean","Leadership"], keywords: ["operations manager","operational","process"] },
  { title: "HR Manager", industry: "Human Resource", degree: "Psikologi / Manajemen SDM", education: ["S1 Psikologi","S1 Manajemen"], skills: ["Recruitment","Performance Management","Employee Relations","HRIS","Policies"], keywords: ["hr","human resource","people operations"] },
  { title: "Business Development Manager", industry: "Bisnis", degree: "Manajemen Bisnis", education: ["S1 Manajemen"], skills: ["Market Research","Negotiation","Partnerships","Sales Strategy","B2B"], keywords: ["business development","partnership","b2b"] },
  // ---------------- BUSINESS & FINANCE ----------------
  { title: "Accountant", industry: "Akuntansi", degree: "Akuntansi", education: ["S1 Akuntansi"], skills: ["Financial Reporting","Tax","Audit","Excel","SAP"], keywords: ["accountant","akuntan","financial reporting", "pajak"] },
  { title: "Financial Analyst", industry: "Keuangan", degree: "Manajemen Keuangan", education: ["S1 Manajemen Keuangan"], skills: ["Financial Modeling","Valuation","Forecasting","Excel","PowerPoint"], keywords: ["financial analyst","finance","investment"] },
  { title: "Auditor", industry: "Akuntansi", degree: "Akuntansi", education: ["S1 Akuntansi"], skills: ["Internal Audit","Compliance","Risk Assessment","GAAP","SOX"], keywords: ["auditor","audit","internal controls"] },
  { title: "Tax Consultant", industry: "Perpajakan", degree: "Akuntansi", education: ["S1 Akuntansi"], skills: ["Tax Planning","PPh","PPN","Regulasi Pajak","Oracle"], keywords: ["tax","perpajakan","brevet","consultant"] },
  { title: "Management Consultant", industry: "Konsultasi", degree: "Manajemen", education: ["S1-S2 Manajemen"], skills: ["Strategy","Analysis","Problem Solving","Presenting","Change Mnmt"], keywords: ["management consultant","strategy","analyst"] },
  { title: "Sales Executive", industry: "Penjualan", degree: "Manajemen Pemasaran", education: ["D3/S1 Manajemen"], skills: ["Sales","CRM","Negotiation","Cold Calling","Closing"], keywords: ["sales","account executive","salesman"] },
  { title: "Marketing Manager", industry: "Pemasaran", degree: "Manajemen Pemasaran", education: ["S1 Manajemen Pemasaran"], skills: ["Brand Strategy","Digital Marketing","Market Analysis","Campaign","Budget"], keywords: ["marketing manager","brand","campaign"] },
  { title: "Digital Marketer", industry: "Pemasaran Digital", degree: "Ilmu Komunikasi", education: ["S1 Komunikasi"], skills: ["SEO","SEM","Social Ads","Analytics","Copywriting"], keywords: ["digital marketing","seo","sem","google ads"] },

  // ---------------- BANK & PERBANKAN ----------------
  { title: "Bank Teller", industry: "Perbankan", degree: "Manajemen / Ekonomi", education: ["D3/S1 Manajemen"], skills: ["Layanan Nasabah","Transaksi","Kas","Kehati-hatian","SPV Bank"], keywords: ["teller","bank","perbankan","kasir bank"] },
  { title: "Credit Analyst", industry: "Perbankan", degree: "Manajemen Keuangan", education: ["S1 Manajemen Keuangan"], skills: ["Analisis Kredit","Laporan Keuangan","Risk","Underwriting","Excel"], keywords: ["credit analyst","analis kredit","bank"] },
  { title: "Relationship Manager (Bank)", industry: "Perbankan", degree: "Manajemen", education: ["S1 Manajemen"], skills: ["Customer Relations","Sales","Portofolio","Cross-selling","KYC"], keywords: ["relationship manager","banking","nasabah"] },
  { title: "Investment Analyst", industry: "Keuangan/Investasi", degree: "Manajemen Keuangan", education: ["S1-S2 Keuangan"], skills: ["Equity Research","DCF","Portofolio","Bloomberg","Valuation"], keywords: ["investment analyst","equity","capital market"] },
  { title: "Risk Analyst", industry: "Keuangan", degree: "Manajemen Risiko", education: ["S1 Statistika/Keuangan"], skills: ["Risk Modeling","VaR","Stress Testing","Python","SQL"], keywords: ["risk analyst","risk management","modeling"] },
  { title: "Loan Officer", industry: "Perbankan", degree: "Ekonomi", education: ["S1 Ekonomi"], skills: ["Kredit","Verifikasi","NASABAH","Collection","Analisis"] , keywords: ["loan officer","kredit","pembiayaan"] },
  // ---------------- KESEHATAN & FARMASI ----------------
  { title: "Pharmacist (Apoteker)", industry: "Farmasi", degree: "Farmasi", education: ["S1 Farmasi","Profesi Apoteker"], skills: ["Obat-obatan","Pelayanan Resep","Farmakologi","Komunitas","BPOM"], keywords: ["apoteker","pharmacist","farmasi","obat"] },
  { title: "Nurse (Perawat)", industry: "Kesehatan", degree: "Keperawatan", education: ["D3/S1 Keperawatan","Ners"], skills: ["Asuhan Keperawatan","IGD","Pasien","Dokumentasi","NGO"], keywords: ["perawat","nurse","rs","kesehatan"] },
  { title: "Medical Lab Analyst", industry: "Kesehatan", degree: "Analis Kesehatan", education: ["D3 Analis Kesehatan"], skills: ["Laboratorium","Hematologi","Kimia Klinik","Mikrobiologi","QC"], keywords: ["analis laboratorium","medical lab","kesehatan"] },
  { title: "Nutritionist (Ahli Gizi)", industry: "Kesehatan", degree: "Gizi", education: ["S1 Gizi","Profesi Dietisien"], skills: ["Nutrisi","Diet","Gizi Klinis","Edukasi","Inovasi"], keywords: ["ahli gizi","nutritionist","dietisien"] },
  // ---------------- CREATIVE / CONTENT ----------------
  { title: "Content Creator", industry: "Media/Konten", degree: "Ilmu Komunikasi", education: ["S1 Komunikasi","D3 Multimedia"], skills: ["Video Editing","Copywriting","Social Media","SEO Content","Storytelling"], keywords: ["content creator","konten kreator","youtube","tiktok"] },
  { title: "Video Editor", industry: "Media", degree: "Multimedia", education: ["D3 Multimedia"], skills: ["Premiere Pro","After Effects","DaVinci","Color Grading","Storytelling"], keywords: ["video editor","editor video","post production"] },
  { title: "Graphic Designer", industry: "Desain", degree: "Desain Komunikasi Visual", education: ["S1 DKV"], skills: ["Photoshop","Illustrator","Branding","Layout","Typography"], keywords: ["graphic designer","desain grafis","visual"] },
  { title: "UI/UX Designer", industry: "Desain/Teknologi", degree: "Desain / Interaksi", education: ["S1 DKV","Sosial"], skills: ["Figma","User Research","Prototyping","Wireframe","Accessibility"], keywords: ["ui ux","product designer","figma"] },
  { title: "Social Media Specialist", industry: "Pemasaran Digital", degree: "Komunikasi", education: ["S1 Komunikasi"], skills: ["Instagram","TikTok","Content Calendar","Analytics","Community"], keywords: ["social media","sosmed","instagram","content"] },
  { title: "Copywriter", industry: "Konten", degree: "Bahasa/Sastra", education: ["S1 Sastra"], skills: ["Copywriting","SEO","Brand Voice","Editing","Persuasion"], keywords: ["copywriter","tulis","konten","ad copy"] },
  // ---------------- PROFESI LAIN ----------------
  { title: "Lawyer (Pengacara)", industry: "Hukum", degree: "Hukum", education: ["S1 Hukum","Profesi Advokat"], skills: ["Litigasi","Kontrak","Legal Research","Hukum Bisnis","Negosiasi"], keywords: ["pengacara","lawyer","advokat","hukum"] },
  { title: "Civil Engineer (Teknik Sipil)", industry: "Konstruksi", degree: "Teknik Sipil", education: ["S1 Teknik Sipil"], skills: ["Struktur","AutoCAD","Manajemen Konstruksi","Estimate","K3"], keywords: ["civil engineer","teknik sipil","konstruksi"] },
  { title: "Teacher (Guru)", industry: "Pendidikan", degree: "Pendidikan", education: ["S1 Pendidikan"], skills: ["Mengajar","Kurikulum","Evaluasi","Kelas","PPP"], keywords: ["guru","teacher","pendidikan","dosen"] },
  { title: "Translator", industry: "Bahasa", degree: "Sastra/Bahasa", education: ["S1 Sastra"], skills: ["Translation","Interpretation","Localization","CAT Tools","Revisi"], keywords: ["translator","penerjemah","bahasa"] },
  { title: "Logistics / Supply Chain", industry: "Logistik", degree: "Logistik", education: ["S1 Manajemen Logistik"], skills: ["Inventory","Forecasting","Transportasi","SAP/ERP","Optimasi"], keywords: ["logistics","supply chain","warehouse","distribusi"] },
  { title: "Public Relations Specialist", industry: "Korporat", degree: "Komunikasi", education: ["S1 Hubungan Masyarakat"], skills: ["Media Relation","Press Release","Crisis Comms","Branding","Events"], keywords: ["public relations","humas","media"] },
  { title: "Entrepreneur (Founder)", industry: "Bisnis", degree: "Manajemen", education: ["S1 Manajemen"], skills: ["Business Strategy","Growth","Fundraising","Leadership","P&L"], keywords: ["founder","startup","entrepreneur","bisnis"] },
];

// ============================================================================
// LOWONGAN YANG BERAGAM (agar AI punya banyak jenis pekerjaan utk dicocokkan)
// ============================================================================
const JOB_POOL = [
  { title: "Senior Frontend Engineer", company: "Gojek", industry: "Teknologi", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "LinkedIn", match_score: 91, acceptance_potential: 85, is_green: false },
  { title: "Backend Engineer (Go)", company: "Kredivo", industry: "Teknologi", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "LinkedIn", match_score: 87, acceptance_potential: 84 },
  { title: "Data Scientist", company: "Bukalapak", industry: "Data & AI", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Ashby", match_score: 85, acceptance_potential: 82 },
  { title: "DevOps Engineer", company: "OVO", industry: "Teknologi", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Workable", match_score: 83, acceptance_potential: 79 },
  { title: "UI/UX Designer", company: "GoTo", industry: "Desain", location: "Bandung", type: "full-time", workplace_type: "hybrid", platform_source: "Greenhouse", match_score: 84, acceptance_potential: 80 },
  { title: "Product Manager", company: "Tiket.com", industry: "Teknologi", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Lever", match_score: 76, acceptance_potential: 71 },
  { title: "Project Manager", company: "Telkom Indonesia", industry: "Manajemen", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 74, acceptance_potential: 69 },
  { title: "Accountant", company: "Deloitte Indonesia", industry: "Akuntansi", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 88, acceptance_potential: 84 },
  { title: "Financial Analyst", company: "Mandiri Sekuritas", industry: "Keuangan", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "Lever", match_score: 86, acceptance_potential: 82 },
  { title: "Tax Consultant", company: "PricewaterhouseCoopers", industry: "Perpajakan", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "Greenhouse", match_score: 81, acceptance_potential: 78 },
  { title: "Bank Teller", company: "Bank BCA", industry: "Perbankan", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 70, acceptance_potential: 66 },
  { title: "Credit Analyst", company: "Bank Mandiri", industry: "Perbankan", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "LinkedIn", match_score: 79, acceptance_potential: 75 },
  { title: "Pharmacist (Apoteker)", company: "Kimia Farma", industry: "Farmasi", location: "Bandung", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 90, acceptance_potential: 87 },
  { title: "Nurse (Perawat)", company: "RS Siloam", industry: "Kesehatan", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 82, acceptance_potential: 78 },
  { title: "Content Creator", company: "Dream Digital Media", industry: "Media/Konten", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "LinkedIn", match_score: 85, acceptance_potential: 81 },
  { title: "Graphic Designer", company: "Alodokter", industry: "Desain", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Greenhouse", match_score: 80, acceptance_potential: 76 },
  { title: "Social Media Specialist", company: "Tokopedia", industry: "Pemasaran", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Lever", match_score: 78, acceptance_potential: 74 },
  { title: "Digital Marketer", company: "GoPay", industry: "Pemasaran", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Ashby", match_score: 77, acceptance_potential: 73 },
  { title: "Civil Engineer", company: "Waskita Karya", industry: "Konstruksi", location: "Jakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 84, acceptance_potential: 80 },
  { title: "Teacher (Guru)", company: "Sekolah Citra Bangsa", industry: "Pendidikan", location: "Yogyakarta", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 75, acceptance_potential: 71 },
  { title: "Sustainability Analyst", company: "Xurya Daya Indonesia", industry: "Energi", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "LinkedIn", match_score: 82, acceptance_potential: 78, is_green: true },
  { title: "Renewable Energy Engineer", company: "PLN Icon Plus", industry: "Energi", location: "Bandung", type: "full-time", workplace_type: "on-site", platform_source: "JobStreet", match_score: 80, acceptance_potential: 77, is_green: true },
  { title: "HR Manager", company: "Unilever Indonesia", industry: "Human Resource", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Lever", match_score: 83, acceptance_potential: 79 },
  { title: "Marketing Manager", company: "Danone Indonesia", industry: "Pemasaran", location: "Jakarta", type: "full-time", workplace_type: "hybrid", platform_source: "Greenhouse", match_score: 81, acceptance_potential: 77 },
];

function professionFor(i) {
  return PROFESSIONS[i % PROFESSIONS.length];   // rotasi: tiap profesi dpt ~1-2 user
}

async function createUser(i, prof) {
  const email = `user${String(i + 1).padStart(3, "0")}@${EMAIL_DOMAIN}`;
  const name = `${pick(NAMES)} ${pick(NAMES)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name, job_profile: prof.title },
  });
  if (error) return { email, error };
  const user = data?.user;   // data = { user, session }; ambil record user yg asli
  if (!user) return { email, error: { message: "createUser returned no user record" } };
  return { email, user, name, ok: true };
}

// helper: jangan sampai insert gagal tanpa terlihat (seed harus diagnosable)
function check(step, res) {
  if (res?.error) console.warn(`  [seed:${step}] ${res.error.message} (${res.error.code || ""})`);
  return res;
}

async function seedForUser(userId, name, email, prof) {
  const city = pick(CITIES);
  const years = 1 + Math.floor(Math.random() * 12);
  const skills = prof.skills && prof.skills.length
    ? sample(prof.skills, Math.min(prof.skills.length, 6))
    : [];

  check("profiles", await admin.from("profiles").upsert({
    id: userId,
    full_name: name,
    current_title: prof.title,
    experience_years: years,
    location: city,
    linkedin_url: `https://linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 6)}`,
    skills: skills,
    preferred_platforms: ["LinkedIn", "JobStreet", "Kalibrr"],
    resume_url: `https://example.com/resume/${email.split("@")[0]}.pdf`,
  }));

  // Pengalaman kerja (1-2 entri sesuai industri)
  const startMonth = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const jobs0 = [{ role_title: prof.title, company_name: `Perusahaan ${prof.industry} A`, start_date: `${2026 - years}-${startMonth}-01` }];
  if (years > 2) jobs0.push({ role_title: `Junior ${prof.title}`, company_name: `Perusahaan ${prof.industry} B`, start_date: `${2026 - Math.ceil(years / 2)}-01-01`, end_date: `${2026 - Math.floor(years / 2)}-12-31` });
  for (const w of jobs0) {
    check("work_experiences", await admin.from("work_experiences").insert({
      user_id: userId, company_name: w.company_name, role_title: w.role_title,
      employment_type: "full-time", location_type: "on-site",
      start_date: w.start_date, end_date: w.end_date || null,
      is_current: !w.end_date,
      description: `Bekerja sebagai ${w.role_title} di sektor ${prof.industry}.`,
      achievements: JSON.stringify([{ title: "Target tercapai", detail: "Kontribusi positif tim" }]),
      skills_used: skills.slice(0, 3), // live: TEXT[]
      industry: prof.industry,
    }));
  }

  check("education", await admin.from("education").insert({
    user_id: userId,
    institution: pick(["Universitas Indonesia","Universitas Gadjah Mada","Universitas Brawijaya","Universitas Padjadjaran","Politeknik Negeri","Institut Teknologi Bandung","Universitas Airlangga","Universitas Diponegoro"]),
    degree: prof.degree, field_of_study: prof.degree,
    start_year: 2026 - years - 4, end_year: 2026 - years,
    is_current: false, gpa: 3 + Math.random(), max_gpa: 4,
    description: `${prof.degree} — fokus ${prof.industry}.`,
  }));

  const SKILL_CATEGORIES = ["technical", "soft", "language", "tool"];
  for (let i = 0; i < skills.length; i++) {
    check("user_skills", await admin.from("user_skills").insert({
      user_id: userId, name: skills[i], category: SKILL_CATEGORIES[i % SKILL_CATEGORIES.length],
      proficiency_level: 3 + Math.floor(Math.random() * 3), is_verified: false,
    }));
  }

  check("user_automation_settings", await admin.from("user_automation_settings").upsert({
    user_id: userId,
    first_name: name.split(" ")[0], last_name: name.split(" ").slice(1).join(" ") || name,
    current_city: city, country: "Indonesia",
    search_location: "Indonesia",
    search_keywords: prof.keywords || [prof.title.toLowerCase()],
    desired_salary: 5000000 + Math.floor(Math.random() * 13) * 1000000,
    notice_period: 30,
    pause_before_submit: true,
    ai_provider: "openrouter",
    ai_model: "openai/gpt-oss-20b:free",
  }));

  check("subscriptions", await admin.from("subscriptions").upsert({
    user_id: userId,
    plan_name: iFree(userId) ? "Free" : "Pro",
    ai_model_tier: iFree(userId) ? "free" : "pro",
    daily_apply_quota: iFree(userId) ? 10 : 100,
    monthly_quota: iFree(userId) ? 10 : 100,
    used_quota: 0,
    status: "active",
  }));
}

function iFree(userId) { return (userId.charCodeAt(userId.length - 1) % 10) > 2; }

async function seedJobs() {
  for (const j of JOB_POOL) {
    await admin.from("jobs").upsert({
      ...j,
      status: "active",
      description: `${j.title} di ${j.company} (${j.industry}) — lowongan untuk menguji pencocokan AI Applify.`,
      requirements: ["Pengalaman 2+ tahun", "Komunikasi baik", "Kolaborasi tim"],
    }, { onConflict: "id" });
  }
  console.log(`Seeded ${JOB_POOL.length} jenis lowongan beragam.`);
}

(async () => {
  console.log(`Membuat ${USER_COUNT} user dengan background beragam...`);
  const profs = {};
  let created = 0;
  for (let i = 0; i < USER_COUNT; i++) {
    const prof = professionFor(i);
    profs[prof.title] = (profs[prof.title] || 0) + 1;
    const r = await createUser(i, prof);
    if (!r.ok) { console.warn(`skip ${r.email}: ${r.error?.message}`); continue; }
    await seedForUser(r.user.id, r.name, r.email, prof);
    created++;
  }
  console.log(`\nUser dibuat: ${created}`);
  console.log("Sebaran profesi:", JSON.stringify(profs, null, 0));
  await seedJobs();
  console.log("Selesai. Login: user001@example.com .. user100@example.com /", PASSWORD);
  console.log("Total jenis profesi di katalog:", PROFESSIONS.length, "(tinggal tambah utk ~500)");
})().catch((e) => { console.error(e); process.exit(1); });




