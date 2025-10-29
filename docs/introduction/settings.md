(settings)=

# Settings

## Overview

The Shapescape NBT Replacer is a high-performance filter for finding and replacing strings within NBT (Named Binary Tag) files. It supports multiple file formats including `.nbt`, `.mcstructure`, and compressed variants (`.gz`, `.zlib`).

## Configuration Structure

```json
{
	"filter": "shapescape_nbt_replacer",
	"settings": {
		"rules": [
			{
				"path": "**/*.mcstructure",
				"property": "facing",
				"from": "west",
				"to": "north",
				"regex": false,
				"flags": "g",
				"notify": true
			}
		]
	}
}
```

## Parameters

### rules

**Type:** `Array<Rule>`  
**Required:** Yes  
**Description:** An array of replacement rules. Each rule defines a separate find-and-replace operation on NBT files.

#### Rule Object Properties

##### path

**Type:** `string`  
**Required:** Yes  
**Description:** Glob pattern to match files for processing. Supports standard glob syntax:

- `*` matches any characters except path separator
- `**` matches any characters including path separators (for recursive directory matching)
- `?` matches a single character
- `[abc]` matches characters in brackets

**Examples:**

```json
"path": "**/*.nbt"           // All .nbt files in all subdirectories
"path": "structures/*.mcstructure"  // All .mcstructure files in structures folder
"path": "**/*.mcstructure.gz"       // All compressed .mcstructure files
```

##### property

**Type:** `string`  
**Optional:** Yes  
**Default:** `null` (matches all string tags)  
**Description:** Target a specific NBT tag name. When specified, only string tags with this exact name will be processed. If omitted, all string tags matching the search criteria will be processed.

**Examples:**

```json
"property": "facing"        // Only replace in tags named "facing"
"property": "id"           // Only replace in tags named "id"
"property": "CustomName"   // Only replace in tags named "CustomName"
```

##### from

**Type:** `string`  
**Required:** Yes  
**Description:** The string or pattern to search for.

- If `regex` is `false`: performs exact string matching (the entire string value must match)
- If `regex` is `true`: treats this as a regular expression pattern

**Examples:**

```json
"from": "west"                    // Exact match (when regex: false)
"from": "minecraft:stone"         // Exact match
"from": "^minecraft:.*_log$"      // Regex pattern (when regex: true)
"from": "old_\\w+_name"           // Regex with word characters
```

**Note:** Use `\\b` for word boundaries in regex patterns (it will be normalized internally).

##### to

**Type:** `string`  
**Required:** Yes  
**Description:** The replacement string. Can include regex capture groups when using `regex: true`.

**Examples:**

```json
"to": "north"                          // Simple replacement
"to": "minecraft:oak_log"              // Namespace replacement
"to": "$1_new_$2"                      // With regex capture groups
```

##### regex

**Type:** `boolean`  
**Optional:** Yes  
**Default:** `false`  
**Description:** Determines matching behavior:

- `false`: Exact string matching - the entire string value must match `from` exactly
- `true`: Regular expression matching - `from` is treated as a regex pattern

**Important:** When `regex` is `false`, only complete string matches are replaced, not partial matches within strings.

##### flags

**Type:** `string`  
**Optional:** Yes  
**Default:** `"g"` (global)  
**Description:** Regular expression flags (only used when `regex` is `true`).

**Common flags:**

- `g` - Global: replace all matches
- `i` - Case-insensitive matching
- `m` - Multiline: `^` and `$` match line boundaries
- `s` - Dotall: `.` matches newlines

**Examples:**

```json
"flags": "gi"    // Global + case-insensitive
"flags": "g"     // Global only (default)
"flags": "gim"   // Multiple flags combined
```

##### notify

**Type:** `boolean`  
**Optional:** Yes  
**Default:** Rule inherits from global `notify` setting  
**Description:** When `true`, logs detailed information about each replacement including:

- File path
- Tag path (hierarchical location in NBT structure)
- Old value
- New value

**Output example:**

```
[Replace] structures/house.mcstructure :: palette > [0] > Name :: "minecraft:stone" -> "minecraft:cobblestone"
```

## Complete Example

```json
{
	"filter": "shapescape_nbt_replacer",
	"settings": {
		"rules": [
			{
				"path": "**/*.mcstructure",
				"property": "facing",
				"from": "west",
				"to": "north",
				"regex": false,
				"notify": true
			},
			{
				"path": "structures/village/**/*.nbt",
				"from": "^minecraft:(.+)_planks$",
				"to": "minecraft:oak_$1",
				"regex": true,
				"flags": "g"
			},
			{
				"path": "**/*.mcstructure.gz",
				"property": "id",
				"from": "minecraft:chest",
				"to": "minecraft:barrel",
				"regex": false
			}
		]
	}
}
```

## How It Works

### 1. File Discovery

The filter uses fast-glob to find all files matching the `path` pattern for each rule.

### 2. NBT Parsing

For each file, the tool attempts to parse it as NBT using multiple strategies:

- Bedrock Edition format (with optional compression)
- Java Edition format
- Little-endian and big-endian variants
- Gzip, zlib, or uncompressed

### 3. String Traversal

The tool recursively traverses the NBT structure:

- **Compound tags**: Checks each key-value pair
- **List tags**: Processes each element
- **String tags**: Candidates for replacement

### 4. Matching & Replacement

For each string tag:

- If `property` is specified, only tags with that name are considered
- If `regex` is `true`: applies the regex pattern with specified flags
- If `regex` is `false`: performs exact string comparison
- Replacements are made in-memory

### 5. Writing

Modified files are written back to disk using the same NBT format they were read in.

## Performance Features

### Adaptive Concurrency

The tool automatically adjusts concurrent file operations based on disk I/O performance:

- Monitors task completion times
- Increases concurrency when tasks complete faster
- Decreases concurrency when tasks slow down
- Default concurrency is CPU cores × 2

### Optimized Parsing

Multiple parsing strategies are attempted in order of likelihood:

- File extension-based heuristics (`.mcstructure` tries Bedrock format first)
- Automatic fallback to alternative formats
- Minimal overhead for successful parses

## Tips & Best Practices

1. **Use `property` filters**: Narrow down replacements to specific tag names for precision
2. **Start with exact matching**: Use `regex: false` until you need pattern matching
3. **Enable `notify` during development**: Verify replacements are working as expected
4. **Use specific glob patterns**: Narrow file selection for better performance
5. **Backup your files**: Always work on copies when testing new rules

## Common Use Cases

### Rotating Blocks

```json
{
	"path": "**/*.mcstructure",
	"property": "facing",
	"from": "west",
	"to": "north",
	"regex": false
}
```

### Block ID Migration

```json
{
	"path": "**/*.nbt",
	"property": "id",
	"from": "^minecraft:stone$",
	"to": "minecraft:cobblestone",
	"regex": true
}
```

### Namespace Updates

```json
{
	"path": "structures/**/*.mcstructure",
	"from": "^mymod:(.*)",
	"to": "mynewmod:$1",
	"regex": true,
	"flags": "g"
}
```
