-- Tabelas do robô Superendividamento no projeto juridicopro (prefixo se_).
-- NÃO aplicado ainda: rodar só com autorização do George.
create table if not exists public.se_conversas (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,                 -- número do lead (55DDDN...)
  nome_perfil text,
  etapa text not null default 'novo',         -- novo | consentimento | triagem | viavel | inviavel | docs | pagamento | assinatura | cliente | handoff | encerrado
  origem text,                                -- ads_whatsapp | organico
  ad_id text,                                 -- referral.source_id do anúncio Click-to-WhatsApp
  ctwa_clid text,                             -- para atribuição na Conversions API
  referral jsonb,
  consentimento_em timestamptz,
  handoff_em timestamptz,
  triagem jsonb,                              -- renda, dívidas, credores, % comprometido, resultado
  crm_lead_id uuid references public.crm_leads(id),
  cliente_id uuid references public.clientes(id),
  criado_em timestamptz not null default now(),
  ultima_msg_em timestamptz
);
comment on table public.se_conversas is 'Uma linha por contato do robô WhatsApp Superendividamento. Estado da conversa + atribuição do anúncio.';

create table if not exists public.se_mensagens (
  id bigint generated always as identity primary key,
  conversa_id uuid references public.se_conversas(id) on delete cascade,
  wa_id text not null,
  direcao text not null check (direcao in ('in','out')),
  tipo text not null,                         -- text | image | document | audio | interactive | ...
  texto text,
  wa_message_id text unique,
  payload jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists se_mensagens_conversa_idx on public.se_mensagens (conversa_id, criado_em);

alter table public.se_conversas enable row level security;
alter table public.se_mensagens enable row level security;
-- Sem policies: só a service role (o robô) lê e escreve.
