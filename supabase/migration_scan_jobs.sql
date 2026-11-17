-- ============================================================
-- v2.16.0 任务队列：让扫描入库在云端自动执行，浏览器可随时关闭
-- 两张新表 + RLS + 索引。写入统一走 Edge Function（service_role），
-- 前端 anon 只读；跨设备隔离靠 sync_code 查询过滤（与现有 vw_user_states 一致）。
-- ============================================================

-- 任务单
create table if not exists public.vw_scan_jobs (
  id           bigint generated always as identity primary key,
  job_no       text unique not null,
  sync_code    text not null,
  book_id      text not null default 'victor',
  status       text not null default 'queued',   -- queued 排队 / running 执行中 / done 待验收 / accepted 已验收
  total_pages  integer not null default 0,
  done_pages   integer not null default 0,
  failed_pages integer not null default 0,
  words_found  integer not null default 0,
  fingerprint  text,                              -- 同一批图片指纹，防重复提交
  error_msg    text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  accepted_at  timestamptz,
  locked_at    timestamptz                        -- pg_cron worker 软锁，防并发重复领取
);

-- 任务明细（每页一条 = 用户要的「过程执行结果」）
create table if not exists public.vw_scan_job_pages (
  id           bigint generated always as identity primary key,
  job_id       bigint not null references public.vw_scan_jobs(id) on delete cascade,
  sync_code    text not null,
  seq          integer not null,                  -- 执行顺序
  image_url    text not null,
  image_path   text,
  page_no      integer,                           -- detect 后回填
  status       text not null default 'pending',   -- pending / running / done / error / skipped
  words_found  integer not null default 0,
  senses_found integer not null default 0,
  api_calls    integer not null default 0,
  error_msg    text,
  batch_id     bigint,                            -- 关联 vw_scan_batches
  result       jsonb,                             -- scan 回执摘要 + nextContext
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_jobs_sync     on public.vw_scan_jobs (sync_code, created_at desc);
create index if not exists idx_jobs_status   on public.vw_scan_jobs (status, locked_at);
create index if not exists idx_jobpages_job  on public.vw_scan_job_pages (job_id, seq);
create index if not exists idx_jobpages_stat on public.vw_scan_job_pages (status);

-- RLS：anon 只读（前端按 sync_code 过滤），写入由 service_role 的 Edge Function 完成
alter table public.vw_scan_jobs      enable row level security;
alter table public.vw_scan_job_pages enable row level security;

drop policy if exists "jobs anon read" on public.vw_scan_jobs;
create policy "jobs anon read" on public.vw_scan_jobs for select to anon, authenticated using (true);

drop policy if exists "job pages anon read" on public.vw_scan_job_pages;
create policy "job pages anon read" on public.vw_scan_job_pages for select to anon, authenticated using (true);
