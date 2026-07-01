const STOPWORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 
  'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 
  'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 
  'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 
  'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 
  'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 
  'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 
  // Custom conversational fluff
  'please', 'fix', 'help', 'code', 'file', 'check', 'write', 'create', 'update',
  'make', 'sure', 'thank', 'thanks', 'ahead', 'look', 'find'
]);

export class QueryAnalyzer {
  /**
   * Extracts high-signal lexical keywords from a query string.
   */
  static extractKeywords(text: string): string[] {
    if (!text) return [];

    // Simple word boundary tokenizer, extracting words >= 3 chars
    const tokens = text.toLowerCase().match(/\b[a-z]{3,}\b/g);
    if (!tokens) return [];

    const keywords = new Set<string>();
    
    for (const token of tokens) {
      if (!STOPWORDS.has(token)) {
        keywords.add(token);
      }
    }

    return Array.from(keywords);
  }

  /**
   * Extracts keywords from the last 'user' message in the array.
   */
  static extractFromMessages(messages: any[]): string[] {
    if (!messages || messages.length === 0) return [];
    
    // Find last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
        return this.extractKeywords(messages[i].content);
      }
    }
    
    return [];
  }
}
