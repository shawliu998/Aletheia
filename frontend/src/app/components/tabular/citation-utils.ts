"use client";

const INLINE_METADATA_RE = /\[\[((?:[^\[\]]|\[[^\]]*\])+)\]\]/g;

export interface ParsedCitation {
    page?: number;
    sheet?: string;
    cell?: string;
    quote: string;
}

export interface ResolvedCellCitation extends ParsedCitation {
    citationRef: number;
    section: "summary" | "reasoning";
}

/**
 * Replaces [[page:n||quote:...]] markers with `§idx§` placeholders.
 * Returns the processed string and an ordered array of extracted citation data.
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const citations: ParsedCitation[] = [];
    INLINE_METADATA_RE.lastIndex = 0;
    const processed = text.replace(
        INLINE_METADATA_RE,
        (fullMarker, rawMetadata: string) => {
            const pageCitation = parsePageCitation(rawMetadata);
            const spreadsheetCitation = parseSpreadsheetCitation(rawMetadata);
            const citation = pageCitation ?? spreadsheetCitation;
            if (!citation) return fullMarker;

            const idx = citations.length;
            citations.push(citation);
            return `§${idx}§`;
        },
    );
    return { processed, citations };
}

type CitationSection = {
    name: ResolvedCellCitation["section"];
    text: string;
    citationOffset: number;
};

type NormalizedText = {
    text: string;
    sourceIndices: number[];
};

/**
 * Resolves a tabular-chat excerpt back to the closest document citation in the
 * cited cell. Chat annotations intentionally retain Mike's row/column contract;
 * the source locator already embedded in the cell remains the authority.
 *
 * Ambiguous multi-citation cells fail closed: when the quoted excerpt cannot be
 * found, this returns undefined instead of opening a potentially unrelated
 * source passage.
 */
export function resolveCellCitationFromExcerpt(
    summary: string | undefined,
    reasoning: string | undefined,
    excerpt: string,
): ResolvedCellCitation | undefined {
    const summaryResult = preprocessCitations(summary ?? "");
    const reasoningResult = preprocessCitations(reasoning ?? "");
    const sections: CitationSection[] = [
        {
            name: "summary",
            text: summary ?? "",
            citationOffset: 0,
        },
        {
            name: "reasoning",
            text: reasoning ?? "",
            citationOffset: summaryResult.citations.length,
        },
    ];
    const totalCitations =
        summaryResult.citations.length + reasoningResult.citations.length;
    const normalizedExcerpt = normalizeComparableText(
        removeCitationTokens(preprocessCitations(excerpt).processed).plain,
    ).text;

    let best:
        | {
              citation: ResolvedCellCitation;
              distance: number;
          }
        | undefined;

    for (const section of sections) {
        const parsed = preprocessCitations(section.text);
        if (parsed.citations.length === 0 || !normalizedExcerpt) continue;

        const tokenized = removeCitationTokens(parsed.processed);
        const normalizedSource = normalizeComparableText(tokenized.plain);
        const excerptStart = normalizedSource.text.indexOf(normalizedExcerpt);
        if (excerptStart < 0) continue;
        const excerptEnd = excerptStart + normalizedExcerpt.length;

        tokenized.citationPositions.forEach((plainPosition, index) => {
            const normalizedPosition = normalizedIndexAtSourcePosition(
                normalizedSource.sourceIndices,
                plainPosition,
            );
            const distance =
                normalizedPosition < excerptStart
                    ? excerptStart - normalizedPosition
                    : normalizedPosition > excerptEnd
                      ? normalizedPosition - excerptEnd
                      : 0;
            const candidate: ResolvedCellCitation = {
                ...parsed.citations[index],
                citationRef: section.citationOffset + index + 1,
                section: section.name,
            };
            if (!best || distance < best.distance) {
                best = { citation: candidate, distance };
            }
        });
    }

    if (best) return best.citation;
    if (totalCitations !== 1) return undefined;

    if (summaryResult.citations[0]) {
        return {
            ...summaryResult.citations[0],
            citationRef: 1,
            section: "summary",
        };
    }
    if (reasoningResult.citations[0]) {
        return {
            ...reasoningResult.citations[0],
            citationRef: 1,
            section: "reasoning",
        };
    }
    return undefined;
}

function removeCitationTokens(value: string): {
    plain: string;
    citationPositions: number[];
} {
    const citationPositions: number[] = [];
    let plain = "";
    let cursor = 0;
    const tokenPattern = /§(\d+)§/g;
    let match: RegExpExecArray | null;

    while ((match = tokenPattern.exec(value))) {
        plain += value.slice(cursor, match.index);
        citationPositions[Number(match[1])] = plain.length;
        cursor = match.index + match[0].length;
    }
    plain += value.slice(cursor);
    return { plain, citationPositions };
}

function normalizeComparableText(value: string): NormalizedText {
    let text = "";
    const sourceIndices: number[] = [];
    let whitespacePending = false;
    let whitespaceIndex = 0;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (/\s/u.test(character)) {
            if (text.length > 0) {
                whitespacePending = true;
                whitespaceIndex = index;
            }
            continue;
        }
        if (/[*_`#>~\[\]]/u.test(character)) continue;
        if (whitespacePending) {
            text += " ";
            sourceIndices.push(whitespaceIndex);
            whitespacePending = false;
        }
        text += character.toLocaleLowerCase();
        sourceIndices.push(index);
    }

    return { text: text.trim(), sourceIndices };
}

function normalizedIndexAtSourcePosition(
    sourceIndices: number[],
    sourcePosition: number,
): number {
    const index = sourceIndices.findIndex(
        (candidate) => candidate >= sourcePosition,
    );
    return index < 0 ? sourceIndices.length : index;
}

function parsePageCitation(metadata: string): ParsedCitation | null {
    const match = metadata.match(/^page:(\d+)\|\|(?:quote:)?([\s\S]+)$/i);
    if (!match) return null;
    return {
        page: parseInt(match[1], 10),
        quote: match[2].trim(),
    };
}

function parseSpreadsheetCitation(metadata: string): ParsedCitation | null {
    if (!metadata.toLowerCase().startsWith("sheet:")) return null;

    const quoteSeparator = metadata.search(/\|\|quote:/i);
    if (quoteSeparator < 0) return null;

    const locatorMetadata = metadata.slice(0, quoteSeparator);
    const quote = metadata
        .slice(quoteSeparator)
        .replace(/^\|\|quote:/i, "")
        .trim();
    if (!quote) return null;

    const fields = new Map<string, string>();
    for (const part of locatorMetadata.split("||")) {
        const separator = part.indexOf(":");
        if (separator < 0) continue;
        const key = part.slice(0, separator).trim().toLowerCase();
        const value = part.slice(separator + 1).trim();
        if (value) fields.set(key, value);
    }

    const sheet = fields.get("sheet");
    const row = fields.get("row");
    const column = fields.get("col") ?? fields.get("column");
    const cell = fields.get("cell") ?? (column && row ? `${column}${row}` : undefined);
    if (!sheet || !cell) return null;

    return { sheet, cell, quote };
}
