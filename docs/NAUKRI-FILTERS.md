# Naukri search filters — confirmed live

Measured on **2026-09-28** in a DRY browser session with the bot profile: the filter panel
of `https://www.naukri.com/data-analyst-jobs` (plus `business-analyst`, `sales-executive`,
`accountant`, `software-engineer` for more cities) was inspected, each filter was applied
in the panel, and the resulting URL was recorded. Only search-filter controls were
clicked — never a job and never a job's Apply button. Scripts: session scratchpad
(`filters-*.js`), not part of the app.

**Only the parameters below may be used anywhere in ApplyIt** (`naukri-filters.js` holds
exactly these values). If Naukri changes them, re-measure and update both files.

## URL shape

```
https://www.naukri.com/<keyword-slug>-jobs[-<page>]?<param>=<value>&<param>=<value>…
```
- `<keyword-slug>`: the search keyword, lower-case, non-alphanumerics → `-`
  (e.g. `data-analyst-jobs`, `power-bi-developer-jobs`).
- Page 2+ adds `-2`, `-3`, … to the path; the query string is kept.
- **Multi-select filters repeat the parameter** (`wfhType=2&wfhType=3`).
- A URL loaded directly with several filters is honoured exactly as if they were clicked:
  verified with `?experience=3&wfhType=2&wfhType=3&cityTypeGid=139&cityTypeGid=97&ctcFilter=6to10&jobAge=7`
  → 106 results, all five checkboxes shown checked, "Last 7 days", experience 3.
- A page number beyond the last page redirects to page 1 of the same search.

## Filters

### Experience — `experience` (single value)
A slider in the panel ("0 Yrs … 30 Yrs"), **one number**: the candidate's years of
experience. Confirmed values 0, 1, 3, 5, 7, 15, 30; values above 30 are clamped to 30.
Naukri has **no min/max experience range** in the URL.

### Freshness (posted within) — `jobAge` (single value)
Dropdown `#filter-freshness`:

| Label | Value |
|---|---|
| Last 1 day | `jobAge=1` |
| Last 3 days | `jobAge=3` |
| Last 7 days | `jobAge=7` |
| Last 15 days | `jobAge=15` |
| Last 30 days | `jobAge=30` |

### Work mode — `wfhType` (multi)
| Label | Value |
|---|---|
| Work from office | `wfhType=0` |
| Remote | `wfhType=2` |
| Hybrid | `wfhType=3` |

(The panel also lists "Temp. WFH due to covid"; its value was not measured and it is not used.)

### Location — `cityTypeGid` (multi)
Numeric ids, read from the URL after selecting each city in the Location "View More" list:

| City | id | City | id | City | id |
|---|---|---|---|---|---|
| Ahmedabad | 51 | Hyderabad | 17 | Noida | 220 |
| Bengaluru | 97 | India (anywhere) | 9011 | Pune | 139 |
| Chandigarh | 4 | Indore | 125 | Surat | 64 |
| Chennai | 183 | Jaipur | 173 | Thane | 323 |
| Coimbatore | 184 | Khopoli | 349 | Thiruvananthapuram | 120 |
| Delhi / NCR | 9508 | Kochi | 110 | Vadodara | 65 |
| Gurugram | 73 | Kolkata | 232 | Lonavala | 507 |
| Lucknow | 216 | Mohali | 167 | Mumbai | 134 |
| Mumbai (All Areas) | 9509 | Nagpur | 136 | Navi Mumbai | 138 |
| New Delhi | 6 | | | | |

28 cities. Naukri shows the top ~25 cities per search, so more exist; only these ids are
confirmed. "India" is a Naukri location label (jobs listed as India-wide), not "any city".

### Salary — `ctcFilter` (multi)
| Label | Value | Label | Value |
|---|---|---|---|
| 0-3 Lakhs | `0to3` | 25-50 Lakhs | `25to50` |
| 3-6 Lakhs | `3to6` | 50-75 Lakhs | `50to75` |
| 6-10 Lakhs | `6to10` | 75-100 Lakhs | `75to100` |
| 10-15 Lakhs | `10to15` | 1-5 Cr | `100to500` |
| 15-25 Lakhs | `15to25` | | |

### Seen in the panel, not measured (not used)
Department (`functionAreaIdGid`), Company type (`qbusinessSize`), Role category
(`glbl_qcrc`), Education (`ugTypeGid`, `pgTypeGid`), Posted by (`jobPostType`: Company /
Consultant jobs), Industry (`industryTypeIdGid`), Top companies (`qctopGroupId`), and a
"Sort by: Recommended" control. Their values are ids that were not recorded.
