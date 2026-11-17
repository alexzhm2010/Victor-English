-- ============================================================
-- v2.9.0 同步码系统
--  1) vw_sync_codes：同步码字典（code / 备注 / 是否超级码）
--  2) vw_user_states：按同步码隔离的「单词定义空间」学习状态
--     已会 / 不会 / 进度；主键 (code, word_id) 保证一码一词一条
--  3) 预置超级码 663798
--  4) 把旧的 vw_words.tags 状态迁移到超级码名下
-- ============================================================

-- 1. 同步码字典
create table if not exists public.vw_sync_codes (
  code       text primary key,
  note       text default '',
  is_super   boolean default false,
  created_at timestamptz default now()
);
alter table public.vw_sync_codes enable row level security;
drop policy if exists "vw sync codes read" on public.vw_sync_codes;
create policy "vw sync codes read" on public.vw_sync_codes for select using (true);

-- 2. 用户学习状态（按同步码隔离）
create table if not exists public.vw_user_states (
  code       text not null references public.vw_sync_codes(code) on delete cascade,
  word_id    bigint not null references public.vw_words(id) on delete cascade,
  tags       text[] not null default '{}',
  updated_at timestamptz default now(),
  primary key (code, word_id)
);
alter table public.vw_user_states enable row level security;
drop policy if exists "vw user states all" on public.vw_user_states;
create policy "vw user states all" on public.vw_user_states for all using (true) with check (true);

-- 3. 预置超级码 663798（若已存在则升级为超级码）
insert into public.vw_sync_codes (code, note, is_super)
  values ('663798', '超级码：可进入扫描页与设置页', true)
  on conflict (code) do update set is_super = true;

-- 4. 迁移旧状态：vw_words.tags 里已有的三态 → 超级码名下（忽略非三态旧标签）
insert into public.vw_user_states (code, word_id, tags, updated_at)
select '663798', id,
       array(select t from unnest(tags) t where t in ('已会','不会','进度')),
       now()
  from public.vw_words
 where tags is not null
   and tags && array['已会','不会','进度']
on conflict (code, word_id) do nothing;
