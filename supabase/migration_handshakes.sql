-- ============================================================
-- 迁移：跨页残段"握手池"
-- 目标项目：gjtjivmxxelnousbqmok（vw_ 隔离区）
-- 目的：让跨页单词在任意录入顺序、任意时间间隔下都能自动补全。
--   每页有两个残段状态：
--     side='head' 页首残段（延续上一页某词，等上一页来握手）
--     side='tail' 页尾残段（被下一页延续，等下一页来握手）
--   握手信息常驻本表，每次新页入库前后都到池里检查/登记，
--   而不是只在同一次批次的相邻页之间用内存传递。
-- 幂等：唯一键 (book_id, page_no, side) —— 同一页同一侧永远只有一条记录；
--   重复扫描用 upsert 覆盖，不产生重复行；合并本身按 pos|sense_no + 例句文本去重。
-- 可重复执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.vw_page_handshakes (
  id                BIGSERIAL PRIMARY KEY,
  book_id           TEXT        NOT NULL,
  page_no           INTEGER     NOT NULL,
  side              TEXT        NOT NULL CHECK (side IN ('head', 'tail')),
  neighbor_page_no  INTEGER,                       -- 待握手的对端页码：head=page_no-1, tail=page_no+1
  headword          TEXT,                          -- 残词词头（tail 侧明确；head 侧可能为空，词头在上一页）
  word_id           BIGINT,                        -- 残段已落库成词条时的 vw_words.id（head 侧一般为 null）
  payload           JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 残段 senses 快照（含 pos/sense_no/chinese_def/items）
  status            TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等核心：每页每侧唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_vw_handshake
  ON public.vw_page_handshakes (book_id, page_no, side);

-- 握手检索：按"对端页码 + 侧 + 状态"快速找到待握手残段
CREATE INDEX IF NOT EXISTS idx_vw_handshake_neighbor
  ON public.vw_page_handshakes (book_id, side, neighbor_page_no, status);

ALTER TABLE public.vw_page_handshakes ENABLE ROW LEVEL SECURITY;

-- 前端只读（用于展示待握手状态/调试）；写入由后端 service_role 完成，绕过 RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vw_page_handshakes'
      AND policyname = 'vw handshake public read'
  ) THEN
    CREATE POLICY "vw handshake public read"
      ON public.vw_page_handshakes FOR SELECT USING (true);
  END IF;
END $$;

GRANT SELECT ON public.vw_page_handshakes TO anon, authenticated;
