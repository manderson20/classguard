-- Migration 061: Artificial Intelligence filter category.
--
-- Neither UT1 nor Shallalist (the two upstream blocklist sources this
-- system syncs weekly) has any AI-chatbot coverage — both predate modern
-- generative AI by years — so this domain list is curated by hand rather
-- than inherited from a sync, same as how new categories get seeded
-- (see migration 056's self_harm addition for precedent).
--
-- Opt-in, not blocked by default: this sits with the medium-risk,
-- admin-configurable cluster (proxy_vpn, dating, social_media) rather than
-- the always-blocked CIPA-driven tier (adult, violence, weapons, etc.) —
-- admins add a block rule per-policy if they want it enforced, the same way
-- Gaming/Social Media/Streaming work today.
INSERT INTO website_categories (slug, name, description, risk_level, is_blocked_default, sort_order)
VALUES (
  'ai_tools',
  'Artificial Intelligence',
  'AI chatbots, writing/paraphrasing assistants, and image/video/voice generators — academic integrity and content-appropriateness concern, not blocked by default.',
  'medium',
  false,
  12
)
ON CONFLICT (slug) DO NOTHING;

-- Make room in the medium-risk cluster (slot 12, right after Social Media)
-- without disturbing the high-risk tier above it.
UPDATE website_categories SET sort_order = sort_order + 1
WHERE slug <> 'ai_tools' AND sort_order >= 12;

-- Deliberately excluded: Grammarly and similar grammar-checking tools —
-- widely used legitimately for writing support/accessibility, not a
-- cheating-tool in the same sense as a full essay generator. Also excluded:
-- huggingface.co and bing.com — both host AI chat at a sub-path but share
-- the domain with broad legitimate (ML research / general search) traffic
-- that domain-level blocking can't carve out from.
INSERT INTO domain_categories (domain, category_id, source, confidence)
SELECT d.domain, wc.id, 'manual', 100
FROM website_categories wc
CROSS JOIN (VALUES
  -- Chatbots / general AI assistants
  ('chat.openai.com'), ('chatgpt.com'), ('claude.ai'), ('gemini.google.com'),
  ('bard.google.com'), ('copilot.microsoft.com'), ('perplexity.ai'),
  ('you.com'), ('pi.ai'), ('poe.com'), ('character.ai'), ('meta.ai'),
  ('grok.com'), ('x.ai'), ('deepseek.com'), ('chat.deepseek.com'),
  ('qwen.ai'), ('chat.mistral.ai'), ('mistral.ai'), ('chat.groq.com'),
  ('socratic.org'),
  -- Writing / paraphrasing / essay tools
  ('quillbot.com'), ('jasper.ai'), ('copy.ai'), ('writesonic.com'),
  ('rytr.me'), ('sudowrite.com'), ('caktus.ai'), ('essaygenius.ai'),
  ('wordtune.com'),
  -- Image / video / voice generation
  ('midjourney.com'), ('leonardo.ai'), ('runwayml.com'), ('civitai.com'),
  ('stability.ai'), ('ideogram.ai'), ('elevenlabs.io'), ('play.ht'),
  ('synthesia.io'), ('pika.art'), ('kaiber.ai')
) AS d(domain)
WHERE wc.slug = 'ai_tools'
ON CONFLICT (domain, category_id) DO NOTHING;
