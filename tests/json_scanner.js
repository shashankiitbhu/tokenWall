function minifyJsonBlocks(text) {
  let result = text.replace(/```json\s*([\s\S]*?)\s*```/ig, (match, jsonString) => {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(jsonString))}\n\`\`\``;
    } catch {
      return match;
    }
  });

  // Extract raw un-fenced JSON objects/arrays
  // We look for { or [ that start a line (ignoring whitespace).
  let out = '';
  let i = 0;
  while (i < result.length) {
    let c = result[i];
    
    // Quick heuristic: look for { or [ that is preceded by whitespace/newline
    if ((c === '{' || c === '[') && (i === 0 || /\s/.test(result[i-1]))) {
      let braceCount = 0;
      let inString = false;
      let escape = false;
      let j = i;
      
      let isObject = c === '{';
      
      for (; j < result.length; j++) {
        let char = result[j];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (char === '\\') {
            escape = true;
          } else if (char === '"') {
            inString = false;
          }
        } else {
          if (char === '"') {
            inString = true;
          } else if (char === '{' || char === '[') {
            braceCount++;
          } else if (char === '}' || char === ']') {
            braceCount--;
            if (braceCount === 0) {
              // Found a complete block
              let block = result.substring(i, j + 1);
              try {
                let parsed = JSON.parse(block);
                // Only minify if it's reasonably large (e.g. > 50 chars) to avoid ruining small inline examples
                if (block.length > 50) {
                  let minified = JSON.stringify(parsed);
                  out += minified;
                  i = j + 1;
                  break;
                }
              } catch (e) {
                // Not valid JSON, ignore
              }
              // If we reach here, parsing failed or too small, fall back to normal
              break;
            }
          }
        }
      }
      
      if (braceCount === 0 && i !== j + 1) {
        // Did not break out by successfully replacing
        out += result[i];
        i++;
      } else if (braceCount !== 0) {
        // Unclosed brace
        out += result[i];
        i++;
      }
    } else {
      out += result[i];
      i++;
    }
  }
  return out;
}

const test1 = `Here is some text.
{
  "hello": "world",
  "nested": [
    1, 2, { "a": "b" }
  ]
}
More text here.`;

console.log(minifyJsonBlocks(test1));
