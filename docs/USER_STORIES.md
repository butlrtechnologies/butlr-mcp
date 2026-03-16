# User Stories for Butlr MCP Server

This document contains user stories organized by stakeholder role that guide the design of MCP tools for accessing Butlr's privacy-first occupancy data and APIs. Each story follows the standard "As a [stakeholder], I want ... so that ..." structure and is anchored in capabilities described in Butlr's documentation.

---

## IT / Facilities & Building Operations

### Device Health and Inventory

**As an IT administrator**, I want to list all sensors and hives for a given site/floor and see their status (e.g., serial number, model, last-seen time, online/offline), so that I can maintain uptime and plan battery/wired maintenance.

**Rationale:** The GraphQL API manages detailed asset data for sensors and hives, and enterprises expect reliability and device-uptime SLAs for intelligent-building platforms.

### Coverage and Deployment Planning

**As a facilities engineer**, I want to view which rooms and zones have traffic-mode vs. presence-mode sensors and check their coverage areas, so that I can ensure accurate occupancy counts and plan additional installations.

**Rationale:** Traffic-mode sensors count entries/exits and reset counts daily, while presence-mode sensors provide real-time detections within a defined coverage area; understanding sensor type and coverage is essential for accurate metrics.

### API/Webhook Health

**As an IT administrator**, I want to monitor API latency and webhook delivery status, so that our automation (e.g., HVAC and cleaning triggers) meets enterprise SLAs.

**Rationale:** Enterprise-grade AI platforms require predictable latency and reliability and offer standardized REST APIs and webhooks to push occupancy events into energy, cleaning and space-planning workflows.

### BMS Integration

**As a facilities integrator**, I want to configure and test occupancy webhooks that publish entryway traffic, floor occupancy and motion detections, so that I can feed real-time signals into building-management systems (BMS) and automate HVAC/lighting controls.

**Rationale:** Butlr's API-first platform supports webhooks for real-time occupancy and traffic counts; integration with BMS and HVAC controls is a core smart-building trend.

---

## Office Manager / Facilities Manager

### Real-time Room Availability

**As an office manager**, I want to see live occupancy of meeting rooms, focus areas and shared spaces, so that I can direct employees to available rooms and avoid overcrowding.

**Rationale:** Presence-mode sensors provide granular occupancy data for specific zones; the Heatic sensor delivers anonymous real-time detections via Butlr's APIs.

### Historical Utilization Trends

**As a workplace planner**, I want to query historical occupancy for rooms/floors over selectable time ranges (hourly/daily), so that I can identify under-used spaces and adjust desk assignments or reconfigure layouts.

**Rationale:** The Reporting API provides time-series occupancy data for floors, rooms and zones to analyze historical trends; analyzing space-usage data helps managers decide whether to downsize or repurpose space.

### Cleaning and Maintenance Scheduling

**As a facility services manager**, I want to trigger cleaning tasks when occupancy thresholds are met (e.g., conference room used by ≥10 people), so that cleaning crews focus on areas with verified use and reduce wasted labor and supplies.

**Rationale:** Combining occupancy sensors with AI enables on-demand cleaning workflows; thermal occupancy sensors let cleaning crews focus on areas with verified use, cutting wasted labor and consumables.

### Safety and Compliance

**As an office manager**, I want to monitor occupant counts in real time to avoid exceeding capacity limits and to support emergency evacuation procedures.

**Rationale:** Traffic-mode sensors count people entering and exiting spaces and can be aggregated at floor/room levels.

### Occupant-Experience Insights

**As an employee-experience manager**, I want to analyze movement patterns and occupancy of collaboration spaces, so that I can optimize the mix of meeting rooms, desks and social areas and improve employee satisfaction.

**Rationale:** Occupancy sensors enable deep dives into workspace usage; movement data helps optimize spaces for collaboration and improves employee organization (e.g., checking room availability).

---

## Executive / Leadership

### Portfolio-Level Utilization Dashboards

**As an executive**, I want to view aggregated occupancy metrics across sites, buildings and floors, so that I can understand how hybrid work patterns affect our space and workforce strategy.

**Rationale:** The Butlr data model allows granular aggregation from sensors up to campus-level insights, and executives need high-level views to make strategic decisions on rightsizing and workplace policies.

### Energy & Sustainability Monitoring

**As an executive**, I want to track energy consumption and savings achieved through occupancy-driven HVAC and lighting control, so that we can meet ESG commitments and reduce carbon emissions.

**Rationale:** Occupancy-driven HVAC control can cut energy use by 10–20%, and sensors can be connected to lighting and HVAC systems to improve energy efficiency.

### ROI and Cost-Savings Analysis

**As a finance or real-estate leader**, I want reports that quantify cost savings from energy reduction, rightsizing (deferred real-estate costs) and demand-based cleaning, so that I can justify the investment in occupancy sensing and plan budgets.

**Rationale:** Data-driven occupancy programs must quantify financial impact—energy savings, deferred capital from rightsizing, and reduced labor via demand-based cleaning; occupancy data helps determine if moving to a smaller office is feasible.

### Privacy & Compliance Oversight

**As an executive responsible for data governance**, I want to verify that occupancy sensing remains anonymous and complies with privacy and security regulations, so that employees and stakeholders trust the system.

**Rationale:** Butlr's thermal sensors capture heat signatures without recording images and are designed to be privacy-first, but executives should still audit privacy practices and data policies.

---

## Real Estate & Workplace Planning

### Space-Optimization Analysis

**As a corporate real-estate manager**, I want to analyze occupancy by site, building, floor, room and zone to determine which areas are under-utilized or over-crowded, so that I can decide whether to consolidate, repurpose or expand space.

**Rationale:** The Reporting API aggregates occupancy across floors, rooms and zones; occupancy data guides decisions to reconfigure or repurpose floors.

### Heat-Map and Density Metrics

**As a space planner**, I want to generate heat maps and density statistics for specific zones tagged as "focus," "collaboration" or "social," so that I can recommend layout changes and new workspace types.

**Rationale:** Spatial metrics can be filtered by floors, rooms or zones, and asset tags allow filtering assets by category (e.g., zone types).

### Traffic and Queue Management

**As a facilities planner**, I want to see traffic counts at entry points (Ins/Outs) and dwell times in common areas like cafeterias, so that I can reduce bottlenecks and improve amenities.

**Rationale:** Traffic-mode sensors track entries and exits for lobbies, cafeterias and large rooms, and aggregated counts provide high-level occupancy estimates.

### Tag-Based Occupancy Queries

**As a workspace strategist**, I want to query occupancy by asset tag (e.g., "quiet zone," "conference," "amenity") to understand how different types of spaces are used, so that I can align real-estate decisions with employee needs.

**Rationale:** The GraphQL API models floors, rooms, zones and asset tags; the Reporting API includes endpoints to query occupancy by tag.

---

## Finance & Procurement

### Energy-Savings Dashboard

**As a finance manager**, I want a dashboard that converts occupancy-driven HVAC and lighting adjustments into kWh and cost savings, so that I can report on ROI and forecast utility budgets.

**Rationale:** Occupancy-driven ventilation and conditioning save energy and reduce peak loads; energy optimization is a major sustainability trend.

### Cleaning & Staffing Cost Analysis

**As a finance manager**, I want to compare cleaning and staffing costs before and after implementing demand-based cleaning tied to occupancy, so that I can validate labor savings and adjust contracts.

**Rationale:** Thermal occupancy sensors enable cleaning crews to focus on used areas and cut wasted labor.

### Capital Planning & Forecasting

**As a real-estate finance lead**, I want to model the financial impact of consolidating floors or buildings based on occupancy trends, so that I can decide whether to renew leases or invest in new sites.

**Rationale:** Occupancy data helps identify unused space and informs decisions to move to smaller offices; ROI analyses emphasize deferred capital from rightsizing.

### Deployment & Maintenance Budgeting

**As a procurement manager**, I want to estimate the total cost of ownership for wired vs. wireless sensors (hardware, installation, battery maintenance), so that I can allocate budgets appropriately.

**Rationale:** Butlr offers both wired and wireless sensors; wireless units enable fast retrofits but require battery maintenance, while wired sensors support continuous power for mission-critical spaces.

---

## Security, Privacy & Compliance

### Privacy Audit

**As a compliance officer**, I want to audit how occupancy data is anonymized, stored, and retained, and see supporting certifications (e.g., SOC/ISO), so that we can demonstrate adherence to privacy laws and policies.

**Rationale:** Privacy-first platforms capture heat signatures instead of identifiable images; enterprises must review anonymization, retention and role-based access controls.

### Access Controls & Logging

**As a security administrator**, I want to manage role-based permissions for occupancy data and review audit logs of API calls, so that sensitive data is protected and access is documented.

**Rationale:** Enterprise AI platforms need role-based access, audit logs and SLA-backed uptime.

---

## Summary: Tool Capabilities Needed

These user stories highlight the questions that agents should be able to answer through MCP tools. The stories span operational monitoring, workplace management, executive decision-making, real-estate planning and finance. Together, they guide the design of tools such as:

### Asset & Device Management
- Asset-inventory queries (sensors/hives)
- Device status and health monitoring
- Tag-based asset searches

### Occupancy & Space Analytics
- Real-time room/floor occupancy
- Historical occupancy time-series
- Tag-based occupancy queries
- Traffic counts and presence detections

### Reporting & Analysis
- Statistical summaries (peaks, averages, utilization rates)
- Time-range queries with flexible aggregation
- Multi-level aggregation (room → floor → building → site)

### Integration & Automation
- Alerts/webhooks for cleaning and safety thresholds
- Reports for energy savings, cost-savings and ROI

### Privacy & Compliance
- Privacy and compliance audits
- Access control and audit logging

By aligning tool capabilities with these user stories and referencing the Butlr API documentation, the MCP server can enable LLM agents to serve stakeholders from IT to executives while respecting privacy and operational requirements.

---

## Tool Mapping by Stakeholder

This section maps user stories to specific MCP tools that answer each stakeholder's questions.

### IT / Facilities & Building Operations

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Device health and inventory | `butlr_search_assets`, `butlr_get_asset_details` | "Show me all sensors on Floor 3 and their status" |
| Coverage and deployment planning | `butlr_search_assets`, `butlr_get_asset_details` | "Which rooms have traffic-mode sensors?" |
| API/webhook health | *(Future: webhook management tools)* | N/A |
| BMS integration | `butlr_now_summary`, `butlr_traffic_flow` | "Current building occupancy and lobby traffic" |

### Office Manager / Facilities Manager

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Real-time room availability | **`butlr_available_rooms`** | "Are there any conference rooms free?" |
| Historical utilization trends | `butlr_top_used_spaces`, `butlr_get_occupancy_data` | "Most used rooms this month" |
| Cleaning and maintenance scheduling | `butlr_traffic_flow`, `butlr_space_busyness` | "How many people used the large conference room today?" |
| Safety and compliance | `butlr_now_summary`, `butlr_traffic_flow` | "Current floor occupancy and entry counts" |
| Occupant-experience insights | **`butlr_space_insights`**, `butlr_top_used_spaces` | "Which collaboration spaces are most popular?" |

### Executive / Leadership

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Portfolio-level utilization dashboards | **`butlr_now_summary`**, `butlr_top_used_spaces` | "Building occupancy summary across all sites" |
| Energy & sustainability monitoring | `butlr_usage_trend`, **`butlr_space_insights`** | "Energy savings opportunities from underutilized floors" |
| ROI and cost-savings analysis | **`butlr_space_insights`**, `butlr_usage_trend` | "Identify rarely-used spaces for potential consolidation" |
| Privacy & compliance oversight | *(Out of scope - policy/compliance tools)* | N/A |

### Real Estate & Workplace Planning

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Space-optimization analysis | **`butlr_space_insights`**, `butlr_top_used_spaces` | "Which areas are underutilized?" |
| Heat-map and density metrics | `butlr_get_occupancy_data`, `butlr_top_used_spaces` | "Occupancy patterns for focus zones this month" |
| Traffic and queue management | **`butlr_traffic_flow`** | "Lobby entry/exit counts during peak hours" |
| Tag-based occupancy queries | `butlr_top_used_spaces` (with tags), `butlr_search_assets` | "Utilization of all 'quiet zone' spaces" |

### Finance & Procurement

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Energy-savings dashboard | **`butlr_space_insights`**, `butlr_usage_trend` | "Energy savings from reduced HVAC in underutilized floors" |
| Cleaning & staffing cost analysis | `butlr_top_used_spaces`, `butlr_usage_trend` | "Room usage patterns to optimize cleaning schedules" |
| Capital planning & forecasting | **`butlr_space_insights`**, `butlr_get_occupancy_data` | "Forecast impact of consolidating Floor 2" |
| Deployment & maintenance budgeting | `butlr_search_assets`, `butlr_get_asset_details` | "Count of wired vs wireless sensors" |

### Security, Privacy & Compliance

| User Story | MCP Tools | Example Query |
|------------|-----------|---------------|
| Privacy audit | *(Out of scope - MCP is data access only)* | N/A |
| Access controls & logging | *(Out of scope - handled by Butlr platform)* | N/A |

---

## Most Valuable Tools by Use Case

### For Slack/Teams Bots (Tier 1 - Conversational)
**MVP Tools** (implement first):
1. **`butlr_available_rooms`** - Most common question
2. **`butlr_space_busyness`** - Real-time decision making
3. **`butlr_traffic_flow`** - Safety and capacity management
4. **`butlr_top_used_spaces`** - Utilization reporting
5. **`butlr_usage_trend`** - Week-over-week comparisons
6. **`butlr_space_insights`** - Proactive recommendations

### For Power Users / Analytics (Tier 2 - Data)
**Flexible Tools:**
1. **`butlr_get_occupancy_data`** - Custom timeseries queries
2. **`butlr_search_assets`** - Asset discovery

### Coverage Analysis

| Stakeholder Group | Primary Tools Used | Coverage |
|-------------------|-------------------|----------|
| IT / Facilities | `butlr_search_assets`, `butlr_get_asset_details`, `butlr_now_summary` | 60% |
| Office Manager | `butlr_available_rooms`, `butlr_space_busyness`, `butlr_traffic_flow` | 95% |
| Executive | `butlr_now_summary`, `butlr_space_insights` | 80% |
| Real Estate | `butlr_space_insights`, `butlr_top_used_spaces`, `butlr_get_occupancy_data` | 90% |
| Finance | `butlr_space_insights`, `butlr_usage_trend` | 75% |
| Security/Compliance | *(Out of scope)* | N/A |

**Overall Coverage:** 9 tools address ~85% of user story requirements. Remaining 15% involves policy/compliance (out of scope) or future webhook management features.
