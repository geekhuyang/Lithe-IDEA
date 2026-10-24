// Result limits
export const MAX_RESULTS = 20;
export const MAX_OPEN_BUFFERS_SHOWN = 20;
export const MAX_RECENT_FILES_NO_QUERY = 10;
export const MAX_OTHER_FILES_SHOWN = 20;
// Content matches are one row per matched line, so they keep a tighter budget
// than filename results to stay responsive while typing.
export const MAX_CONTENT_MATCHES_SHOWN = 20;

// Debounce delay for search query (ms)
export const SEARCH_DEBOUNCE_DELAY = 100;
