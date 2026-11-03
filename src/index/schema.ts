// Sidecar index schema. The plugin owns this file; it is a cache that can be rebuilt at any time.
import { INDEX_SCHEMA_VERSION } from "../domain/contract.js"

export const SCHEMA_VERSION = INDEX_SCHEMA_VERSION

export const TABLES: readonly string[] = [
  `create table if not exists meta (key text primary key, value text not null)`,
  `create table if not exists projects (id text primary key, worktree text not null, name text)`,
  `create table if not exists sessions (
    id text primary key,
    parent_id text,
    root_id text not null,
    project_id text not null,
    directory text not null,
    title text not null,
    agent text,
    model text,
    cost real not null default 0,
    tokens_input integer not null default 0,
    tokens_output integer not null default 0,
    created integer not null,
    updated integer not null,
    archived integer,
    first_prompt text,
    last_reply text,
    outcome text,
    messages integer not null default 0,
    user_messages integer not null default 0,
    compactions integer not null default 0,
    tool_calls integer not null default 0,
    indexed_seq integer not null default -1,
    indexed_at integer not null default 0
  )`,
  `create index if not exists sessions_root on sessions(root_id)`,
  `create index if not exists sessions_parent on sessions(parent_id)`,
  `create index if not exists sessions_project on sessions(project_id, updated)`,
  `create index if not exists sessions_updated on sessions(updated)`,
  // A doc's metadata and its text live apart, so a search that joins thousands of matches reads small rows.
  `create table if not exists docs (
    id integer primary key,
    session_id text not null,
    root_id text not null,
    message_id text not null,
    seq integer not null,
    part integer not null,
    time integer not null,
    kind text not null,
    tool text
  )`,
  `create index if not exists docs_session on docs(session_id, seq)`,
  `create index if not exists docs_time on docs(time)`,
  `create table if not exists doc_texts (id integer primary key, text text not null)`,
  `create virtual table if not exists docs_words using fts5(text, content='doc_texts', content_rowid='id', tokenize='porter unicode61')`,
  // Trigrams without positions: about a fifth of the size of a full trigram index. It finds texts that hold every
  // trigram of a substring, and the substring itself is then checked against the text.
  `create virtual table if not exists docs_sub using fts5(text, content='doc_texts', content_rowid='id', tokenize='trigram', detail='none', columnsize=0)`,
  `create table if not exists files (
    session_id text not null,
    root_id text not null,
    message_id text not null,
    seq integer not null,
    time integer not null,
    path text not null,
    op text not null,
    tool text not null
  )`,
  `create index if not exists files_path on files(path)`,
  `create index if not exists files_session on files(session_id, seq)`,
  `create table if not exists links (
    parent_id text not null,
    child_id text not null primary key,
    message_id text,
    seq integer not null,
    description text,
    agent text
  )`,
  `create index if not exists links_parent on links(parent_id, seq)`,
  // The seq ranges written per session and the counts taken from each, so re-indexing from a seq
  // replaces counts instead of adding them twice.
  `create table if not exists batches (
    session_id text not null,
    from_seq integer not null,
    to_seq integer not null,
    messages integer not null default 0,
    user_messages integer not null default 0,
    compactions integer not null default 0,
    tool_calls integer not null default 0,
    primary key (session_id, from_seq)
  ) without rowid`,
]

/** Keep both full-text tables in step with doc_texts, and a doc's text with the doc. */
export const TRIGGERS: readonly string[] = [
  `create trigger if not exists doc_texts_ai after insert on doc_texts begin
    insert into docs_words(rowid, text) values (new.id, new.text);
    insert into docs_sub(rowid, text) values (new.id, new.text);
  end`,
  `create trigger if not exists doc_texts_ad after delete on doc_texts begin
    insert into docs_words(docs_words, rowid, text) values ('delete', old.id, old.text);
    insert into docs_sub(docs_sub, rowid, text) values ('delete', old.id, old.text);
  end`,
  `create trigger if not exists docs_ad after delete on docs begin
    delete from doc_texts where id = old.id;
  end`,
]

/** Stable views for history_sql. Table layout may change; these names and columns do not. */
export const VIEWS: readonly string[] = [
  `create view if not exists v_sessions as
    select s.id as session_id, s.parent_id, s.root_id, s.project_id, p.worktree as project, s.directory, s.title,
      s.agent, s.model, s.cost, s.tokens_input, s.tokens_output,
      datetime(s.created / 1000, 'unixepoch') as created, datetime(s.updated / 1000, 'unixepoch') as updated,
      s.archived is not null as archived, s.first_prompt, s.last_reply, s.outcome,
      s.messages, s.user_messages, s.compactions, s.tool_calls
    from sessions s left join projects p on p.id = s.project_id`,
  `create view if not exists v_docs as
    select d.id as doc_id, d.session_id, d.root_id, d.message_id, d.seq, d.part,
      datetime(d.time / 1000, 'unixepoch') as time, d.kind, d.tool, t.text
    from docs d join doc_texts t on t.id = d.id`,
  `create view if not exists v_files as
    select f.session_id, f.root_id, f.message_id, f.seq, datetime(f.time / 1000, 'unixepoch') as time, f.path, f.op, f.tool
    from files f`,
  `create view if not exists v_links as select parent_id, child_id, message_id, description, agent from links`,
]

export const VIEW_NAMES = ["v_sessions", "v_docs", "v_files", "v_links"] as const
