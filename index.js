#!/usr/bin/env node
const argv = require("minimist")(process.argv.slice(2));
const got = require('got');
const tunnel = require('tunnel');
const ejs = require("ejs");
const path = require("path");

if (argv.help) {
  console.log(`SYNOPSIS
    sonar-report [OPTION]...

USAGE
    sonar-report --project=MyProject --application=MyApp --release=v1.0.0 --sonarurl=http://my.sonar.example.com --sonarcomponent=myapp:1.0.0 --sinceleakperiod=true > /tmp/sonar-report

DESCRIPTION
    Generate a vulnerability report from a SonarQube instance.

    Environment: 
    http_proxy : the proxy to use to reach the sonarqube instance (http://<host>:<port>)

    Parameters: 
    --project
        name of the project, displayed in the header of the generated report

    --application
        name of the application, displayed in the header of the generated report

    --release
        name of the release, displayed in the header of the generated report

    --branch
        Branch in Sonarqube that we want to get the issues for

    --pullrequest
        pull request ID in Sonarqube for which to get the issues/hotspots

    --sonarurl
        base URL of the SonarQube instance to query from

    --sonarcomponent
        id of the component to query from

    --sonarusername
        auth username

    --sonarpassword
        auth password

    --sonartoken
        auth token

    --sonarorganization
        name of the sonarcloud.io organization

    --sinceleakperiod
        flag to indicate if the reporting should be done since the last sonarqube leak period (delta analysis). Default is false.

    --allbugs
        flag to indicate if the report should contain all bugs, not only vulnerabilities. Default is false

    --fixMissingRule
        Extract rules without filtering on type (even if allbugs=false). Not useful if allbugs=true. Default is false

    --noSecurityHotspot
        Set this flag for old versions of sonarQube without security hotspots (<7.3). Default is false

    --qualityGateStatus
        Set this flag to include quality gate status in the report. Default is false
        
    --noRulesInReport
        Set this flag to omit "Known Security Rules" section from report. Default is false

    --vulnerabilityPhrase
        Set to override 'Vulnerability' phrase in the report. Default 'Vulnerability'
            
    --vulnerabilityPluralPhrase
        Set to override 'Vulnerabilities' phrase in the report. Default 'Vulnerabilities'    

    --displayStatus
        Display or not the column "Status"
    
    --help
        display this help message`);
  process.exit();
}

function logError(context, error){
  var errorCode = (typeof error.code === 'undefined' || error.code === null) ? "" : error.code;
  var errorMessage = (typeof error.message === 'undefined' || error.message === null) ? "" : error.message;
  var errorResponseStatusCode = (typeof error.response === 'undefined' || error.response === null || error.response.statusCode === 'undefined' || error.response.statusCode === null ) ? "" : error.response.statusCode;
  var errorResponseStatusMessage = (typeof error.response === 'undefined' || error.response === null || error.response.statusMessage === 'undefined' || error.response.statusMessage === null ) ? "" : error.response.statusMessage;
  var errorResponseBody = (typeof error.response === 'undefined' || error.response === null || error.response.body === 'undefined' || error.response.body === null ) ? "" : error.response.body;

  console.error(
    "Error while %s : %s - %s - %s - %s - %s", 
    context, errorCode, errorMessage, errorResponseStatusCode, errorResponseStatusMessage,  errorResponseBody);  
}

(async () => {
  var severity = new Map();
  severity.set('MINOR', 0);
  severity.set('MAJOR', 1);
  severity.set('CRITICAL', 2);
  severity.set('BLOCKER', 3);
  var hotspotSeverities = {"HIGH": "CRITICAL", "MEDIUM": "MAJOR", "LOW": "MINOR"};

  const data = {
    date: new Date().toDateString(),
    projectName: argv.project,
    applicationName: argv.application,
    releaseName: argv.release,
    pullRequest: argv.pullrequest,
    branch: argv.branch,
    sinceLeakPeriod: (argv.sinceleakperiod == 'true'),
    previousPeriod: '',
    allBugs: (argv.allbugs == 'true'),
    fixMissingRule: (argv.fixMissingRule == 'true'),
    noSecurityHotspot: (argv.noSecurityHotspot == 'true'),
    noRulesInReport: (argv.noRulesInReport == 'true'),
    vulnerabilityPhrase: argv.vulnerabilityPhrase || 'Vulnerability',
    vulnerabilityPluralPhrase: argv.vulnerabilityPluralPhrase || 'Vulnerabilities',
    qualityGateStatus: argv.qualityGateStatus,
    // sonar URL without trailing /
    sonarBaseURL: argv.sonarurl.replace(/\/$/, ""),
    sonarOrganization: argv.sonarorganization,
    displayStatus: argv.displayStatus,
    rules: new Map(),
    issues: [],
    hotspots: [],
    hotspotKeys: [],
    duplicationsKeys: [],
    /*
    duplications : [ {
        key: xxx
        blocks:  [ {
            "line": xxx,
            "size": xxx,
            "file": xxx
          },
          {
            "line": xxx,
            "size": xxx,
            "file": xxx
          }, ... ]
      }, ... ]
    */
    duplications: [],
    languages: [], 
    /*
    measures : {
      'coverage' => { value: '0.0' },
      'alert_status' => { value: 'ERROR' },
      'bugs' => { value: '1' },
      'reliability_rating' => { value: '3.0' },
      'code_smells' => { value: '103' },
      'ncloc_language_distribution' => { value: 'java=704;kotlin=6166;xml=1686' },
      'duplicated_lines_density' => { value: '6.5' },
      'security_rating' => { value: '1.0' },
      'vulnerabilities' => { value: '0' },
      'security_review_rating' => { value: '5.0' },
      'sqale_rating' => { value: '1.0' } 
    }
    */
    measures: new Map()
  };

  const leakPeriodFilter = data.sinceLeakPeriod ? '&sinceLeakPeriod=true' : '';
  data.deltaAnalysis = data.sinceLeakPeriod ? 'Yes' : 'No';
  const sonarBaseURL = data.sonarBaseURL;
  const sonarComponent = argv.sonarcomponent;
  const withOrganization = data.sonarOrganization ? `&organization=${data.sonarOrganization}` : '';
  var headers = {};
  var version = null;
  
  var proxy = null;
  // the tunnel agent if a forward proxy is required, or remains null
  var agent = null;
  // Preparing configuration if behind proxy
  if (process.env.http_proxy){
    proxy = process.env.http_proxy;
    var url = new URL(proxy);
    var proxyHost = url.hostname;
    var proxyPort = url.port;
    console.error('using proxy %s:%s', proxyHost, proxyPort);
    agent = {
      https: tunnel.httpsOverHttp({
          proxy: {
              host: proxyHost,
              port: proxyPort
          }
      })
    };
  }
  else{
    console.error('No proxy configuration detected');
  }
  
  //get SonarQube version
  try {
    const res = await got(`${sonarBaseURL}/api/system/status`, {
      agent,
      headers
    });
    const json = JSON.parse(res.body);
    version = json.version;
    //console.log("sonarqube version: %s", version);
    console.error("sonarqube version: %s", version);
  } catch (error) {
      logError("getting version", error);
      return null;
  }

  let DEFAULT_ISSUES_FILTER="";
  let DEFAULT_RULES_FILTER="";
  let ISSUE_STATUSES="";
  let HOTSPOT_STATUSES="TO_REVIEW"

  version= version.substring(0,3);
  //console.log("sonarqube version: %s", version);
  if(data.noSecurityHotspot || version < "7.3"){
    // hotspots don't exist
    DEFAULT_ISSUES_FILTER="&types=VULNERABILITY"
    DEFAULT_RULES_FILTER="&types=VULNERABILITY"
    ISSUE_STATUSES="OPEN,CONFIRMED,REOPENED"
  }
  else if (version >= "7.3" && version < "7.8"){
    // hotspots are stored in the /issues endpoint but issue status doesn't include TO_REVIEW,IN_REVIEW yet
    DEFAULT_ISSUES_FILTER="&types=VULNERABILITY,SECURITY_HOTSPOT"
    DEFAULT_RULES_FILTER="&types=VULNERABILITY,SECURITY_HOTSPOT"
    ISSUE_STATUSES="OPEN,CONFIRMED,REOPENED"
  }
  else if (version >= "7.8" && version < "8.0"){
    // hotspots are stored in the /issues endpoint and issue status includes TO_REVIEW,IN_REVIEW
    DEFAULT_ISSUES_FILTER="&types=VULNERABILITY,SECURITY_HOTSPOT"
    DEFAULT_RULES_FILTER="&types=VULNERABILITY,SECURITY_HOTSPOT"
    ISSUE_STATUSES="OPEN,CONFIRMED,REOPENED,TO_REVIEW,IN_REVIEW"
  }
  else{
    // version >= 8.0
    // hotspots are in a dedicated endpoint: rules have type SECURITY_HOTSPOT but issues don't
    DEFAULT_ISSUES_FILTER="&types=VULNERABILITY"
    DEFAULT_RULES_FILTER="&types=VULNERABILITY,SECURITY_HOTSPOT"
    ISSUE_STATUSES="OPEN,CONFIRMED,REOPENED"
  }

  

  // filters for getting rules and issues
  let filterRule = DEFAULT_RULES_FILTER;
  let filterIssue = DEFAULT_ISSUES_FILTER;
  let filterHotspots = "";
  let filterProjectStatus = "";
  let filterLanguages = "";

  if(data.allBugs){
    filterRule = "";
    filterIssue = "";
  }

  if(data.pullRequest){
    filterIssue=filterIssue + "&pullRequest=" + data.pullRequest
    filterHotspots=filterHotspots + "&pullRequest=" + data.pullRequest
    filterProjectStatus = "&pullRequest=" + data.pullRequest;
  }

  if(data.branch){
    filterIssue=filterIssue + "&branch=" + data.branch
    filterHotspots=filterHotspots + "&branch=" + data.branch
    filterProjectStatus = "&branch=" + data.branch;
  }

  if(data.fixMissingRule){
    filterRule = "";
  }


  const username = argv.sonarusername;
  const password = argv.sonarpassword;
  const token = argv.sonartoken;
  if (username && password) {
    // Form authentication with username/password
    try {
      const response = await got.post(`${sonarBaseURL}/api/authentication/login`, {
          agent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      });
      headers["Cookie"] = response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
    } catch (error) {
        logError("logging in", error);
        return null;
    }
    
  } else if (token) {
    // Basic authentication with user token
    headers["Authorization"] = "Basic " + Buffer.from(token + ":").toString("base64");
  }

  if (data.sinceLeakPeriod) {
    const res = await got(`${sonarBaseURL}/api/settings/values?component=${sonarComponent}&keys=sonar.leak.period`, {
      agent,
      headers
    });
    const json = JSON.parse(res.body);
    data.previousPeriod = json.settings[0].value;
  }

  if (argv.qualityGateStatus === 'true') {
      try {
          const response = await got(`${sonarBaseURL}/api/qualitygates/project_status?projectKey=${sonarComponent}${filterProjectStatus}`, {
              agent,
              headers
          });
          const json = JSON.parse(response.body);
          if (json.projectStatus.conditions) {
              for (const condition of json.projectStatus.conditions) {
                  condition.metricKey = condition.metricKey.replace(/_/g, " ");
              }
          }
          data.qualityGateStatus = json;
      } catch (error) {
          logError("getting quality gate status", error);
          return null;
      }
  }


  try {
    const response = await got(`${sonarBaseURL}/api/measures/component?component=${sonarComponent}&metricKeys=ncloc_language_distribution,alert_status,bugs,code_smells,vulnerabilities,security_hotspots,coverage,duplicated_lines_density,reliability_rating,security_rating,security_review_rating,sqale_rating,`, {
        agent,
        headers
    });
    const json = JSON.parse(response.body);
    //nbResults = json.measures.length;
    //console.log(json.component.measures[0]);
    json.component.measures.forEach(measure => {
      if(measure.metric == "ncloc_language_distribution") {
        const values = measure.value.split(";");
        values.forEach(v => {
          const value_separate = v.split('=');
          data.languages.push({
            "language":value_separate[0],
            "line_count":value_separate[1],
          });
        });
      }
      data.measures.set(
        measure.metric,
        (({value}) => ({value}))(measure)
      );
    });
    //console.log(data.languages);

  } catch (error) {
      logError("getting measures", error);
      return null;
  }
  /*console.log(data.measures);
  return; */


  if(data.languages.length > 0) {
    filterLanguages = "&languages=";
    data.languages.forEach(l => filterLanguages += l.language+",");
  }

  {
    const pageSize = 500;
    const maxResults = 10000;
    const maxPage = maxResults / pageSize;
    let page = 1;
    let nbResults;

  do {
      try {
          const response = await got(`${sonarBaseURL}/api/rules/search?activation=true&f=name,htmlDesc,severity&ps=${pageSize}&p=${page}${filterRule}${withOrganization}${filterLanguages}`, {
              agent,
              headers
          });
          page++;
          const json = JSON.parse(response.body);
          nbResults = json.rules.length;
          json.rules.forEach(r => data.rules.set(
            r.key,
            (({name, htmlDesc, severity}) => ({name, htmlDesc, severity}))(r)
          ));
      } catch (error) {
          logError("getting rules", error);
          return null;
      }
    } while (nbResults === pageSize && page <= maxPage);
  }
 
  
 
  {
    const pageSize = 500;
    const maxResults = 10000;
    const maxPage = maxResults / pageSize;
    let page = 1;
    let nbResults;
    /** Get all statuses except "REVIEWED". 
     * Actions in sonarQube vs status in security hotspot (sonar >= 7): 
     * - resolve as reviewed
     *    "resolution": "FIXED"
     *    "status": "REVIEWED"
     * - open as vulnerability
     *    "status": "OPEN"
     * - set as in review
     *    "status": "IN_REVIEW"
     */
    do {
      try {
          const response = await got(`${sonarBaseURL}/api/issues/search?componentKeys=${sonarComponent}&ps=${pageSize}&p=${page}&statuses=${ISSUE_STATUSES}&resolutions=&s=SEVERITY&asc=no${leakPeriodFilter}${filterIssue}${withOrganization}${filterLanguages}`, {
              agent,
              headers
          });
          page++;
          const json = JSON.parse(response.body);
          nbResults = json.issues.length;
          data.issues = data.issues.concat(json.issues.map(issue => {
            const rule = data.rules.get(issue.rule);
            const message = rule ? rule.name : "/";
            return {
              rule: issue.rule,
              // For security hotspots, the vulnerabilities show without a severity before they are confirmed
              // In this case, get the severity from the rule
              severity: (typeof issue.severity !== 'undefined') ? issue.severity : rule.severity,
              status: issue.status,
              // Take only filename with path, without project name
              component: issue.component.split(':').pop(),
              line: issue.line,
              description: message,
              message: issue.message,
              key: issue.key,
              type: issue.type
            };
          }));
      } catch (error) {
        logError("getting issues", error);  
          return null;
      }
    } while (nbResults === pageSize && page <= maxPage);

    let hSeverity = "";
    if (version >= "8.0" && !data.noSecurityHotspot) {
      // 1) Listing hotspots with hotspots/search
      page = 1;
      do {
        try {
            const response = await got(`${sonarBaseURL}/api/hotspots/search?projectKey=${sonarComponent}${filterHotspots}${withOrganization}&ps=${pageSize}&p=${page}&statuses=${HOTSPOT_STATUSES}&s=SEVERITY`, {
                agent,
                headers
            });
            page++;
            const json = JSON.parse(response.body);
            nbResults = json.hotspots.length;
            data.hotspotKeys.push(...json.hotspots.map(hotspot => hotspot.key));
        } catch (error) {
          logError("getting hotspots list", error);  
            return null;
        }
      } while (nbResults === pageSize && page <= maxPage);

      // 2) Getting hotspots details with hotspots/show
      for (let hotspotKey of data.hotspotKeys){
        try {
            const response = await got(`${sonarBaseURL}/api/hotspots/show?hotspot=${hotspotKey}`, {
                agent,
                headers
            });
            const hotspot = JSON.parse(response.body);
            //console.log(hotspot);
            hSeverity = hotspotSeverities[hotspot.rule.vulnerabilityProbability];
            if (hSeverity === undefined) {
              hSeverity = "MAJOR";
              console.error("Unknown hotspot severity: %s", hotspot.vulnerabilityProbability);
            }
            data.hotspots.push(
              {
                rule: hotspot.rule.key,
                severity: hSeverity,
                status: hotspot.status,
                // Take only filename with path, without project name
                component: hotspot.component.key.split(':').pop(),
                line: hotspot.line,
                description: hotspot.rule ? hotspot.rule.name : "/",
                message: hotspot.message,
                key: hotspot.key
              });
        } catch (error) {
          logError("getting hotspots details", error);  
            return null;
        }
      }

      /********* Duplication lines *********/
      // getting the key (= files)
      page = 1;
      do {
        try {
            const response = await got(`${sonarBaseURL}/api/measures/component_tree?component=${sonarComponent}&ps=${pageSize}&p=${page}&asc=false&metricSort=duplicated_lines_density&s=metric&metricSortFilter=withMeasuresOnly&metricKeys=duplicated_lines_density,duplicated_lines&strategy=leaves`, {
                agent,
                headers
            });
            page++;
            const json = JSON.parse(response.body);
            nbResults = json.components.length;
            json.components.forEach(duplication => {
                if(duplication.measures[0].value > 0) data.duplicationsKeys.push(duplication.key); // push only if value is higher that 0 lignes
            });
            //data.duplicationsKeys.push(...json.components.map(duplication => {duplication.key, duplication.measureskey));
        } catch (error) {
          logError("getting hotspots list", error);  
            return null;
        }
      } while (nbResults === pageSize && page <= maxPage);     

      // Getting the lines concerned in the different files
      for (let duplicationsKey of data.duplicationsKeys){
        try {
            const response = await got(`${sonarBaseURL}/api/duplications/show?key=${duplicationsKey}`, {
                agent,
                headers
            });
            const jsonObj = JSON.parse(response.body);
            jsonObj.duplications.forEach(duplication => {
              let blocks = [];
              duplication.blocks.forEach(block => {
                blocks.push({
                  "line": block.from,
                  "size": block.size,
                  "file": jsonObj.files[block._ref].name
                });
              });

              data.duplications.push({
                "key": duplicationsKey,
                "blocks": blocks
              });
            });
        } catch (error) {
          logError("getting duplication details", error);  
            return null;
        }
      }

      /*for (let duplication of data.duplications){
        for(let block of duplication.blocks) {
          //console.log(block);
          try {
            const response = await got(`${sonarBaseURL}/api/sources/lines?key=${duplication.key}&from=${block.line-3}&to=${block.line+block.size+3}`, {
                agent,
                headers
            });
            const lines = JSON.parse(response.body).sources;
            //TODO Get each lines
            lines.forEach(line => {
              //if(duplication.measures[0].value > 0) data.duplicationsKeys.push(duplication.key); // push only if value is higher that 0 lignes
            });
           
          } catch (error) {
            logError("getting lines details", error);  
              return null;
          }
        }
      }*/

    }


    data.issues.sort(function (a, b) {
      return severity.get(b.severity) - severity.get(a.severity);
    });
  
    data.summary = {
      bugs: data.issues.filter(issue => issue.type === "BUG").length,
      code_smells: data.issues.filter(issue => issue.type === "CODE_SMELL").length,
      vulnerabilities: data.issues.filter(issue => issue.type === "VULNERABILITY").length,
      blocker: data.issues.filter(issue => issue.severity === "BLOCKER").length,
      critical: data.issues.filter(issue => issue.severity === "CRITICAL").length,
      major: data.issues.filter(issue => issue.severity === "MAJOR").length,
      minor: data.issues.filter(issue => issue.severity === "MINOR").length
    };
  }

  ejs.renderFile(`${__dirname}/index.ejs`, data, {}, (err, str) => {
    console.log(str);
    //console.log(err);
  });
})();
