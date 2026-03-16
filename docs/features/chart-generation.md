# Chart Generation & File Exports

> **Status**: 🚧 **Planned** - File generation capabilities are not yet implemented. This document captures research and architectural decisions for future development.

This guide explains how to generate charts, CSV exports, and PDF reports from Butlr occupancy data and deliver them through integrations like Slack.

## Table of Contents

- [Overview](#overview)
- [Supported File Types](#supported-file-types)
- [Chart Generation Architecture](#chart-generation-architecture)
- [CSV Export](#csv-export)
- [PDF Reports](#pdf-reports)
- [File Delivery](#file-delivery)
- [Implementation Considerations](#implementation-considerations)

---

## Overview

File generation extends the Butlr MCP Server with visualization and export capabilities, enabling users to:
- Generate charts from occupancy timeseries data
- Export data as CSV for analysis in Excel/Tableau
- Create PDF reports with embedded charts
- Deliver files directly to Slack threads or other platforms

### What Exists Today

✅ **Butlr MCP Server** provides data tools:
- `butlr_get_occupancy_timeseries` - Timeseries data (traffic + presence)
- `butlr_traffic_flow` - Entry/exit counts with hourly breakdown
- `butlr_space_busyness` - Current occupancy with trends
- All tools return **structured data** + **natural language summaries**

🚧 **Planned**: MCP tools to generate charts/files from this data

---

## Supported File Types

| File Type | Use Case | Library (Proposed) | Output Format |
|-----------|----------|-------------------|---------------|
| **PNG Charts** | Visualizations for Slack/reports | chartjs-node-canvas | Buffer/base64 |
| **CSV** | Data analysis in Excel/Tableau | csv-stringify | Buffer |
| **PDF** | Multi-page reports with charts | pdfkit | Buffer |
| **SVG** | Scalable graphics for web/print | chartjs-node-canvas | String |
| **Excel** | Formatted spreadsheets | exceljs | Buffer |
| **JSON** | API-style data export | native | String |

---

## Chart Generation Architecture

### Proposed Flow

```
User Query
    │
    │ "Plot café traffic for last 12 hours"
    ▼
┌─────────────────────────────────────────┐
│ LLM (Slackbot / AI Assistant)           │
│ Decides to call chart generation tool   │
└─────────────────────────────────────────┘
    │
    │ Step 1: Get data
    ▼
┌─────────────────────────────────────────┐
│ MCP Tool: butlr_get_occupancy_timeseries│
│ Returns: [{ timestamp, count }, ...]    │
└─────────────────────────────────────────┘
    │
    │ Step 2: Generate chart
    ▼
┌─────────────────────────────────────────┐
│ MCP Tool: generate_traffic_chart        │  🚧 Planned
│ Input: timeseries data + config         │
│ Uses: Chart.js + node-canvas            │
│ Returns: PNG buffer + base64            │
└─────────────────────────────────────────┘
    │
    │ Step 3: Deliver file
    ▼
┌─────────────────────────────────────────┐
│ Slackbot uploads file to thread         │  🚧 Planned
│ Using Slack's new upload API            │
└─────────────────────────────────────────┘
```

### Proposed MCP Tool

```typescript
// Pseudocode: New MCP tool for chart generation
{
  name: "generate_traffic_chart",
  description: "Generate chart showing traffic/occupancy over time",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        description: "Timeseries data points",
        items: {
          type: "object",
          properties: {
            timestamp: { type: "string" },
            count: { type: "number" }
          }
        }
      },
      chart_type: {
        type: "string",
        enum: ["line", "bar", "area"],
        default: "line"
      },
      title: { type: "string" },
      width: { type: "number", default: 800 },
      height: { type: "number", default: 400 }
    },
    required: ["data"]
  }
}
```

### Chart Generation Implementation

```typescript
// Pseudocode: Chart generation using chartjs-node-canvas
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

async function generateTrafficChart(data, options) {
  const canvas = new ChartJSNodeCanvas({
    width: options.width || 800,
    height: options.height || 400
  });

  const configuration = {
    type: options.chart_type || 'line',
    data: {
      labels: data.map(d => formatTime(d.timestamp)),
      datasets: [{
        label: 'Occupancy',
        data: data.map(d => d.count),
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.4
      }]
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: options.title || 'Traffic Flow'
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'People' }
        },
        x: {
          title: { display: true, text: 'Time' }
        }
      }
    }
  };

  // Generate PNG buffer
  const imageBuffer = await canvas.renderToBuffer(configuration);

  return {
    image_buffer: imageBuffer,
    image_base64: imageBuffer.toString('base64'),
    filename: `traffic_${Date.now()}.png`,
    mime_type: 'image/png',
    width: options.width,
    height: options.height
  };
}
```

### Chart Types

**Line Charts** - Time-series trends
```typescript
// Occupancy over time, traffic flow patterns
{ chart_type: "line", data: timeseries }
```

**Bar Charts** - Comparisons
```typescript
// Peak hours, space utilization rankings
{ chart_type: "bar", data: hourly_breakdown }
```

**Area Charts** - Cumulative trends
```typescript
// Total visitors, capacity utilization
{ chart_type: "area", data: cumulative_data }
```

**Heatmaps** - Patterns across dimensions
```typescript
// Day-of-week × hour-of-day patterns
{ chart_type: "heatmap", data: weekly_pattern }
```

---

## CSV Export

### Proposed MCP Tool

```typescript
// Pseudocode: CSV export tool
{
  name: "export_occupancy_csv",
  description: "Export occupancy data as CSV file",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        description: "Array of data objects to export"
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Column names (optional, inferred if omitted)"
      },
      filename: {
        type: "string",
        default: "occupancy_data.csv"
      }
    },
    required: ["data"]
  }
}
```

### CSV Generation

```typescript
// Pseudocode: CSV generation
import { stringify } from 'csv-stringify/sync';

async function exportOccupancyCSV(data, options) {
  const csvString = stringify(data, {
    header: true,
    columns: options.columns || Object.keys(data[0])
  });

  const csvBuffer = Buffer.from(csvString, 'utf-8');

  return {
    csv_buffer: csvBuffer,
    csv_content: csvString,
    filename: options.filename || 'occupancy_data.csv',
    mime_type: 'text/csv',
    row_count: data.length
  };
}
```

### Example Output

```csv
timestamp,space_id,space_name,occupancy,capacity,utilization
2025-01-15T10:00:00Z,room_123,Café,12,50,24%
2025-01-15T11:00:00Z,room_123,Café,28,50,56%
2025-01-15T12:00:00Z,room_123,Café,45,50,90%
...
```

---

## PDF Reports

### Proposed MCP Tool

```typescript
// Pseudocode: PDF report generation
{
  name: "generate_occupancy_report",
  description: "Generate PDF report with charts and analytics",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      space_ids: {
        type: "array",
        items: { type: "string" }
      },
      date_range: {
        type: "object",
        properties: {
          start: { type: "string" },
          end: { type: "string" }
        }
      },
      include_charts: { type: "boolean", default: true },
      include_summary: { type: "boolean", default: true }
    },
    required: ["space_ids", "date_range"]
  }
}
```

### PDF Generation

```typescript
// Pseudocode: Multi-page PDF with charts
import PDFDocument from 'pdfkit';

async function generateOccupancyReport(params) {
  const doc = new PDFDocument();
  const chunks = [];

  doc.on('data', chunk => chunks.push(chunk));

  // Cover page
  doc.fontSize(24).text(params.title || 'Occupancy Report', {
    align: 'center'
  });
  doc.fontSize(12).text(`${params.date_range.start} to ${params.date_range.end}`);
  doc.moveDown();

  // Summary statistics
  if (params.include_summary) {
    doc.fontSize(16).text('Summary Statistics', { underline: true });
    doc.fontSize(11).text(`Average Occupancy: ${stats.avg}`);
    doc.text(`Peak Occupancy: ${stats.peak} at ${stats.peak_time}`);
    doc.text(`Total Visitors: ${stats.total}`);
  }

  // Charts
  if (params.include_charts) {
    doc.addPage();
    doc.fontSize(16).text('Traffic Trends', { underline: true });

    // Generate chart
    const chartBuffer = await generateTrafficChart(data, {
      title: 'Traffic Over Time',
      width: 500,
      height: 300
    });

    // Embed in PDF
    doc.image(chartBuffer.image_buffer, {
      fit: [500, 300],
      align: 'center'
    });
  }

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      resolve({
        pdf_buffer: pdfBuffer,
        filename: `occupancy_report_${Date.now()}.pdf`,
        mime_type: 'application/pdf',
        page_count: doc.bufferedPageRange().count
      });
    });
  });
}
```

---

## File Delivery

### Slack File Upload (Planned)

Slack deprecated the old `files.upload` API. New 3-step process required:

```typescript
// Pseudocode: Slack file upload using new API
import { WebClient } from '@slack/web-api';

async function uploadFileToSlack(fileBuffer, filename, channelId, threadTs) {
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  // Step 1: Get upload URL
  const { upload_url, file_id } = await slack.files.getUploadURLExternal({
    filename: filename,
    length: fileBuffer.length
  });

  // Step 2: Upload file to URL
  await fetch(upload_url, {
    method: 'POST',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/octet-stream'
    }
  });

  // Step 3: Complete upload and share to channel
  const result = await slack.files.completeUploadExternal({
    files: [{ id: file_id, title: filename }],
    channel_id: channelId,
    thread_ts: threadTs,  // Optional: share in thread
    initial_comment: "Here's your visualization! 📊"
  });

  return result;
}
```

### Conversational Example

```
User: @butlr plot café traffic for last 12 hours

Butlr: [Calls butlr_get_occupancy_timeseries]
       [Calls generate_traffic_chart]
       [Uploads to Slack]

       📊 [cafe_traffic_12h.png]

       Here's the café traffic for the last 12 hours!
       • Peak: 45 people at 12:30pm
       • Average: 28 people/hour
       • Total visits: 337

User: can you export this as CSV?

Butlr: [Calls export_occupancy_csv]
       [Uploads to Slack]

       📄 [cafe_traffic_2025-01-15.csv]

       Done! The CSV includes hourly occupancy data with timestamps.
```

---

## Implementation Considerations

### Library Selection

**Chart.js + node-canvas** (Recommended)
- ✅ Fast rendering without browser
- ✅ Pure Node.js, no external dependencies
- ✅ Well-maintained, active community
- ✅ Familiar API for web developers
- ❌ Less interactive than Plotly
- ❌ Fewer chart types than D3

**Alternatives Considered:**
- **Plotly.js + Puppeteer**: More features but requires headless browser (heavy)
- **D3.js + JSDOM**: Most flexible but steeper learning curve
- **QuickChart.io API**: External service, rate limits, network dependency

### Performance

**Rendering Speed:**
- Simple line chart (800×400): ~50-100ms
- Complex multi-dataset chart: ~200-500ms
- PDF with 3 charts: ~1-2 seconds

**Memory Usage:**
- Chart.js canvas: ~10-20MB per render
- PDF generation: ~5-10MB per page
- Recommendation: Limit concurrent renders to 5-10

### Caching Strategy

```typescript
// Pseudocode: Chart caching
const chartCache = new LRUCache({
  max: 100,  // Cache 100 charts
  ttl: 1000 * 60 * 15,  // 15 minute TTL
  sizeCalculation: (value) => value.image_buffer.length
});

function getCacheKey(data, options) {
  return hash({ data, options });  // Content-based key
}

async function generateChartWithCache(data, options) {
  const key = getCacheKey(data, options);

  if (chartCache.has(key)) {
    return chartCache.get(key);
  }

  const chart = await generateTrafficChart(data, options);
  chartCache.set(key, chart);
  return chart;
}
```

### Error Handling

```typescript
// Pseudocode: Robust error handling
try {
  const chart = await generateTrafficChart(data, options);
  return chart;
} catch (error) {
  if (error.message.includes('Canvas')) {
    throw new McpError(
      ErrorCode.InternalError,
      'Chart rendering failed. Try reducing image size.',
      { width: options.width, height: options.height }
    );
  } else if (error.message.includes('memory')) {
    throw new McpError(
      ErrorCode.InternalError,
      'Insufficient memory to generate chart. Try smaller dataset.',
      { data_points: data.length }
    );
  }
  throw error;
}
```

---

## Next Steps

Once implemented, file generation tools will enable:
- **Automated reporting** - Daily/weekly occupancy reports delivered to Slack
- **Ad-hoc analysis** - Generate charts on demand during conversations
- **Data exports** - CSV downloads for deeper analysis in BI tools
- **Executive summaries** - PDF reports with charts and insights

---

## Related Documentation

- [Slackbot Integration](../integrations/slackbot.md) - How to deliver files through Slack
- [Conversation Memory](conversation-memory.md) - Context for multi-step file generation
- [MCP Patterns](../architecture/mcp-patterns.md) - How file generation fits into MCP protocol

---

## References

**Research Sources:**
- [chartjs-node-canvas](https://github.com/SeanSobey/ChartJSNodeCanvas) - Chart.js rendering for Node.js
- [Slack Files API](https://api.slack.com/methods/files.completeUploadExternal) - New file upload API
- [PDFKit](http://pdfkit.org/) - PDF generation for Node.js
- [MCP Visualization Servers](https://github.com/antvis/mcp-server-chart) - Existing MCP chart implementations
