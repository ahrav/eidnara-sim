/** The columns of the daemon's `history_segments` the store check reads (`baseline.sql` in eidnara). */
export const SEGMENTS_DDL =
    "create table history_segments (session_id text not null, sequence integer not null, start_message integer not null, end_message integer not null, start_message_id text not null default '', end_message_id text not null default '', title text not null default '', content text not null default '', primary key (session_id, sequence))";
