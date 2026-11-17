-- ============================================================
-- 迁移：页码主导 + partial 半截词标记
-- 目标项目：gjtjivmxxelnousbqmok（现有运营项目的 vw_ 隔离区）
-- 变更：
--   1) vw_words.page_no 改为 NOT NULL DEFAULT 0
--   2) vw_words 新增 partial BOOLEAN（页尾半截词标记）
--   3) 唯一键 (book_id, headword) -> (book_id, headword, page_no)
--      使同一单词在不同页各占一条；重扫同一页则 upsert 合并去重
--   4) vw_scan_batches 新增 prev_page_no / partial_words 记录跨页上下文
-- 幂等：可重复执行
-- ============================================================

-- 1. page_no 非空默认 0（先把历史 NULL 归零）
UPDATE public.vw_words SET page_no = 0 WHERE page_no IS NULL;
ALTER TABLE public.vw_words ALTER COLUMN page_no SET DEFAULT 0;
ALTER TABLE public.vw_words ALTER COLUMN page_no SET NOT NULL;

-- 2. partial 标记
ALTER TABLE public.vw_words ADD COLUMN IF NOT EXISTS partial BOOLEAN DEFAULT FALSE;

-- 3. 换唯一键：先删旧约束，再建含页码的唯一索引
ALTER TABLE public.vw_words DROP CONSTRAINT IF EXISTS vw_words_book_id_headword_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vw_words_book_head_page
  ON public.vw_words (book_id, headword, page_no);

-- 4. 批次表记录跨页上下文
ALTER TABLE public.vw_scan_batches ADD COLUMN IF NOT EXISTS prev_page_no INTEGER;
ALTER TABLE public.vw_scan_batches ADD COLUMN IF NOT EXISTS partial_words JSONB DEFAULT '[]'::jsonb;

-- 5. 供前端查询：视图补充 partial 字段
CREATE OR REPLACE VIEW public.vw_vocab AS
SELECT
  w.id AS word_id, w.headword, w.phonetic, w.level_tag, w.page_no, w.partial,
  s.id AS sense_id, s.pos, s.sense_no, s.chinese_def,
  e.id AS example_id, e.kind, e.en, e.zh, e.source
FROM public.vw_words w
JOIN public.vw_senses s   ON s.word_id = w.id
JOIN public.vw_examples e ON e.sense_id = s.id;
