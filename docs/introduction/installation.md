(installation)=

# Installation

## Steps

### 1. Install the filter

Use the following command

```
regolith install shapescape_nbt_replacer
```

You can alternatively use this command:

```
regolith install github.com/ShapescapeMC/shapescape-nbt-replacer
```

### 2. Add filter to a profile

Add the filter to the `filters` list in the `config.json` file of the Regolith project and add the settings:

```json
{
	"filter": "shapescape_nbt_replacer",
	"settings": {
		"rules": [
			{
				"path": "**/*.mcstructure", // Glob pattern to match files
				"property": "facing", // NBT property to target (optional)
				"from": "west", // String to find
				"to": "north", // String to replace with
				"regex": false, // Whether 'from' is a regex pattern
				"notify": true // Whether to send notifications on replacements
			}
		]
	}
}
```
