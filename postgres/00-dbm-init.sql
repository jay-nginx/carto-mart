-- Datadog Database Monitoring (DBM) bootstrap for PostgreSQL 16.
-- Runs first (alphabetical order in /docker-entrypoint-initdb.d/) so the
-- `datadog` role + extensions are in place before any topology-supplied
-- seed SQL runs.
--
-- Reference: https://docs.datadoghq.com/database_monitoring/setup_postgres/

-- DBM-required extensions. pg_stat_statements ships with the official
-- postgres image but is not installed in the bootstrap database by default.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- The `datadog` role: read-only, plus the pg_monitor predefined role
-- (pg_read_all_settings + pg_read_all_stats + pg_stat_scan_tables).
CREATE USER datadog WITH PASSWORD 'datadogpw';
GRANT pg_monitor TO datadog;
GRANT SELECT ON pg_stat_database TO datadog;

-- DBM's explain plan introspection. The agent calls
-- datadog.explain_statement(query_text) with SECURITY DEFINER so the
-- explain runs with elevated privs even though the agent connects as
-- read-only.
CREATE SCHEMA IF NOT EXISTS datadog;
GRANT USAGE ON SCHEMA datadog TO datadog;

CREATE OR REPLACE FUNCTION datadog.explain_statement(
    l_query TEXT,
    OUT explain JSON
)
RETURNS SETOF JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY EXECUTE 'EXPLAIN (FORMAT JSON) ' || l_query;
END;
$$;

GRANT EXECUTE ON FUNCTION datadog.explain_statement(TEXT) TO datadog;

-- Allow the datadog role to see other users' queries via auto_explain.
ALTER ROLE datadog SET search_path TO datadog, public;
