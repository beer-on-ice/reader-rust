use crate::model::search::SearchBook;

pub const MAX_SEARCH_RESULTS: usize = 50;

fn is_search_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '《' | '》'
                | '〈'
                | '〉'
                | '「'
                | '」'
                | '『'
                | '』'
                | '('
                | ')'
                | '（'
                | '）'
                | '['
                | ']'
                | '【'
                | '】'
                | '·'
                | '-'
                | '—'
                | '_'
                | ':'
                | '：'
                | ','
                | '，'
                | '.'
                | '。'
                | '!'
                | '！'
                | '?'
                | '？'
                | ';'
                | '；'
                | '\''
                | '"'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '/'
                | '\\'
                | '|'
        )
}

pub fn normalize_search_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|ch| !is_search_separator(*ch))
        .collect()
}

pub fn normalize_search_author(value: &str) -> String {
    let normalized = normalize_search_text(value);
    normalized
        .strip_prefix("作者")
        .unwrap_or(&normalized)
        .to_string()
}

fn relevance_score(query: &str, book: &SearchBook) -> u8 {
    let title = normalize_search_text(&book.name);
    let author = normalize_search_author(&book.author);

    if title == query {
        5
    } else if title.starts_with(query) {
        4
    } else if title.contains(query) {
        3
    } else if author == query {
        2
    } else if author.contains(query) {
        1
    } else {
        0
    }
}

fn is_short_query(query: &str) -> bool {
    let length = query.chars().count();
    length < 2
        || (query.is_ascii()
            && query.chars().all(|ch| ch.is_ascii_alphanumeric())
            && length < 3)
}

pub fn rank_search_results(
    query: &str,
    books: Vec<SearchBook>,
    limit: usize,
) -> Vec<SearchBook> {
    let query = normalize_search_text(query);
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }

    let keep_unmatched = is_short_query(&query);
    let mut ranked: Vec<(u8, SearchBook)> = books
        .into_iter()
        .filter_map(|book| {
            let score = relevance_score(&query, &book);
            (score > 0 || keep_unmatched).then_some((score, book))
        })
        .collect();

    ranked.sort_by(|(left, _), (right, _)| right.cmp(left));
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, book)| book).collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize_search_author, normalize_search_text, rank_search_results};
    use crate::model::search::SearchBook;

    fn book(name: &str, author: &str) -> SearchBook {
        SearchBook {
            name: name.into(),
            author: author.into(),
            ..Default::default()
        }
    }

    #[test]
    fn normalization_ignores_case_whitespace_book_marks_and_author_prefix() {
        assert_eq!(normalize_search_text(" 《The 三 体：II》 "), "the三体ii");
        assert_eq!(normalize_search_author("作者： 刘 慈 欣"), "刘慈欣");
    }

    #[test]
    fn regular_query_filters_noise_and_orders_title_before_author_matches() {
        let results = rank_search_results(
            "三体",
            vec![
                book("无关作品", "其他作者"),
                book("三体全集", "刘慈欣"),
                book("三体", "刘慈欣"),
                book("刘慈欣作品集", "三体"),
                book("流浪地球", "三体研究者"),
            ],
            50,
        );
        assert_eq!(
            results
                .iter()
                .map(|book| book.name.as_str())
                .collect::<Vec<_>>(),
            vec!["三体", "三体全集", "刘慈欣作品集", "流浪地球"]
        );
    }

    #[test]
    fn short_query_keeps_noise_but_ranks_matches_first_and_is_stable() {
        let results = rank_search_results(
            "A",
            vec![
                book("noise one", "x"),
                book("A book", "x"),
                book("noise two", "x"),
            ],
            50,
        );
        assert_eq!(
            results
                .iter()
                .map(|book| book.name.as_str())
                .collect::<Vec<_>>(),
            vec!["A book", "noise one", "noise two"]
        );
    }

    #[test]
    fn result_limit_is_a_hard_cap() {
        let books = (0..60)
            .map(|index| book(&format!("三体 {index}"), "刘慈欣"))
            .collect();
        assert_eq!(rank_search_results("三体", books, 50).len(), 50);
    }

    #[test]
    fn punctuation_only_query_returns_no_results() {
        assert!(rank_search_results("《 》", vec![book("三体", "刘慈欣")], 50).is_empty());
    }
}
