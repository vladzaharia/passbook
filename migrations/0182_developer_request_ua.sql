-- Request log (D6). The client that made the call, as a short normalised name (`curl/8.7.1`, `node`,
-- `python-requests`), so the quickstart can say "From your terminal". Never the User-Agent header itself.
ALTER TABLE request_log ADD COLUMN client TEXT CHECK (client IS NULL OR length(client) <= 32);
