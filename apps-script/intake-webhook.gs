// This is the PRE-EXISTING form-intake script bound to the "Trip Inquiries"
// sheet (deployed as its own Web App, receiving POSTs from the 1TripWiser
// website). It was not written as part of this project. It's captured here
// only so the one addition we made — triggering the itinerary workflow
// immediately on a new submission — is tracked in git.
//
// Everything above the `triggerItineraryWorkflow_()` call and the function
// itself are the only changes from the original. Do not otherwise modify
// this file without checking what else depends on it.
//
// One-time setup for the new addition:
//   Project Settings > Script Properties on THIS project:
//     GITHUB_TOKEN = a fine-grained GitHub PAT scoped to just this repo,
//                    with "Contents: Read and write" permission (needed
//                    for the repository_dispatch API). If that's not
//                    enough, also try "Actions: Read and write".
//     GITHUB_REPO  = Drathee25/AIAgentOllama

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var data = JSON.parse(e.postData.contents);

  var headers = ['Timestamp', 'Name', 'Phone', 'Email', 'Destination', 'Travel Date', 'Duration', 'Time Preference', 'Trip Type', 'Adults', 'Children', 'Budget', 'Departing From', 'Notes'];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }

  sheet.appendRow([
    new Date(),
    data.name || '',
    data.phone || '',
    data.email || '',
    data.destination || '',
    data.date || '',
    data.duration || '',
    data.time_pref || '',
    data.trip_type || '',
    data.adults || '',
    data.children || '',
    data.budget || '',
    data.departing || '',
    data.notes || ''
  ]);

  triggerItineraryWorkflow_();

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

// Pings GitHub to run the itinerary-generation workflow immediately instead
// of waiting for a schedule. Deliberately never throws - a failure here
// (bad token, GitHub outage, etc.) must never break the actual form
// intake above, which real customers depend on.
function triggerItineraryWorkflow_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('GITHUB_TOKEN');
    var repo = props.getProperty('GITHUB_REPO');
    if (!token || !repo) return;

    UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json'
      },
      payload: JSON.stringify({ event_type: 'new-trip' }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('Failed to trigger itinerary workflow: ' + err);
  }
}
