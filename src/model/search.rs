use serde::{Deserialize, Serialize};

use super::search_relevance::{normalize_search_author, normalize_search_text};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchBook {
    pub name: String,
    pub author: String,
    pub book_url: String,
    pub origin: String,
    pub cover_url: Option<String>,
    pub intro: Option<String>,
    pub kind: Option<String>,
    pub last_chapter: Option<String>,
    pub update_time: Option<String>,
    pub word_count: Option<String>,
    /// Book source URLs for the same book from different sources (for merged results)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_source_urls: Option<Vec<String>>,
}

impl SearchBook {
    /// Generate a key for merging books with same name and author
    pub fn merge_key(&self) -> String {
        let name = normalize_search_text(&self.name);
        let author = normalize_search_author(&self.author);
        format!("{}|{}", name, author)
    }
}
