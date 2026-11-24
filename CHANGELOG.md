# Changelog

What changed in each release of DeepLabel, newest first. Versions follow
[semantic versioning](https://semver.org): the major number rises for a change that needs
action from whoever runs or calls DeepLabel, the minor for new features, the patch for fixes.
Every release is also a [GitHub release](https://github.com/m2key1/DeepLabel/releases), which
the version in the app's footer opens.

## [Unreleased]

### Added

- Assigning pages: a Manager hands a dataset's pages or ranges to its people, the page table
  shows and filters whose each page is, an Annotator's table keeps to their own pages and the
  unassigned ones, and Next in the page viewer goes to your next page (#137).
- IIIF manifests and collections in Presentation API 4, which the IIIF cookbook already publishes,
  are read like version 3 (#153).
- A second factor at sign-in: an authenticator app and recovery codes, set up on DeepLabel's
  own sign-in page, asked at every sign-in where a deployment requires it, and reset by an
  admin for a lost phone (#135). `python -m app.second_factor_setup` requires it on Authentik.
- Rights for a dataset's scans and a licence for its transcriptions, from a closed list, with
  every change logged. A new dataset asks for the licence, a IIIF import fills the rights, and
  every export carries them (#42, first part).
- Page types: a dataset's pages can be cover, blank, table or image, each type with the steps
  a run takes on it; covers and blanks are not read, and a page line detection found nothing on
  is offered as blank. Datasets and pages carry free metadata, written in Info, exported into
  TEI and PAGE XML, and taken from a IIIF manifest (#40).
- An archived model can be deleted from its page, with its run and checkpoint, by whoever
  trained it or an admin (#152).
- A finished layout run is scored beside its base model on its held-out pages, per class
  and page by page, on the run's page; older runs get it from a button (#150).
- Search every dataset you can open at once, from Search in the top bar (#41).
- A dataset's History tab lists its runs, opens what each changed, and reverts one (#39).
- Your default prompt is an always-open, self-saving editor with your reference images placed
  in the text, sent to the model in that order (#35, first part).
- A IIIF import takes the archive's own transcriptions - an ALTO, PAGE or hOCR file, or text
  annotations - onto their pages (#63).
- The New job wizard shows a PDF as its pages, so single pages or ranges of it can be left out before upload (#46).
- The page editor shows which box, or gathered set of boxes, a colleague has selected (#80).
- A recognition API: pages or line images in, lines and text out, nothing stored (#93). Big
  requests can be queued and fetched later (#96), lines can carry their confidence bands (#97),
  layout regions can be found first (#98), and a request's pages can be kept as a dataset (#99).
  Each account's reading is counted, with an optional monthly cap (#94); a token can be limited to
  chosen models (#110), and an admin can grant a viewer recognition alone (#113).
- A Try page to read your own scans with any model (#95): the text beside the scan and as tall as
  it, following the hovered line (#119), what a scan is waiting on (#108), TIFF scans (#118), a
  choice of reading order (#120), and new scans shown at once (#121).
- Shared notes on datasets and pages.
- Test data: pages marked as test pages stay out of training, a training can be scored on several
  test sets, and each is shown on its own.
- Per-dataset limits on its use for training, scoring, external LLMs and export by others.
- PAGE XML, ALTO, hOCR and TEI import and export with the full layout (#61), the scans in every
  archive export, and a zip of scans taken as pages.
- Text datasets from a IIIF manifest, with their lines exported as Web Annotations.
- A step-by-step New job wizard with page picking and convention flags; a dataset's settings
  change in the same steps.
- A catalog of convention flags with descriptions and examples (#56, #57); an OCR training can
  teach a model new flags.
- Augmentation pipelines for layout and line models, previewed on checked pages; the catalog is
  re-read when a backend is updated (#50).
- Layout element shapes per dataset: aligned boxes, rotated boxes or polygons (#64).
- An Automatic OCR decoding that reads each model the way that suits it (#101), including a
  token decoder's own reading (#102, #103).
- An offer to re-run steps whose model has been replaced, and models marked as another's new
  version.
- A queue drawn as a timeline with estimated start times (#55).
- Sign-in, sign-up with an admin's approval, and passwords on DeepLabel's own pages (#67), with a
  live strength meter (#76); a username works as well as an email (#75).
- A footer with the version and links to the documentation, the source and the issues.
- Every page fits phones and tablets (#87, #104).
- A keyboard map of the shortcuts (#31) and a character keyboard that finds characters by name (#33).
- A transcription check: a model reads a dataset's checked lines to find wrong ground truth, and a
  flagged line is fixed from its row (#126).
- Line models are evaluated against checked outlines: found, missed, merged, split and extra lines,
  with both sets of outlines drawn over the scan (#130).
- A run past its best can be stopped at once, keeping its best epoch as the model, where its
  model backend can do so (DeepOCR) (#125).

### Changed

- A step switched on after some pages went through without it is offered on just those pages,
  and a page layout passed by no longer counts as layout done (#138).
- A dataset's pages are ingested beside the GPU queue, two datasets at a time, and the dataset
  shows as Ingesting until it joins the queue (#140).
- The Corpus tab is folded into the dataset's menus: documents under More, cutting again in
  Run, reading against the documents in the language-model dialog, a No document match filter,
  and each page's stretch in the page viewer; old Corpus links open the dataset (#49).
- The page table shows which pages are marked lines complete, the ones line detection trains
  on, in a Lines column with its own filters; the text filters are now called Text checked and
  Text unchecked (#78).
- The training form and pre-flight say the validation share is drawn as whole pages (#127).
- Layout training repeats a small training set so each epoch holds 200 pages, stops early on
  its smoothed score, defaults to 100 epochs instead of 1000 and keeps only its best weights; a
  cluster run brings back only its model and leaves no folder behind, and the pre-flight warns
  about classes with too few boxes (#146).
- A model and the run that made it are one page, opening on what it learned from and how the
  training went (#123); a run shows the epochs it was left to train for (#115).
- Every evaluated model is one row of one table, a column per test set and one score per cell (#124).
- A model family draws its versions as one line and names them in full (#53, #91).
- A finished OCR run is scored in Automatic decoding only (#122).
- A run from a trained model stops early by default, after 10 validations without a better score,
  and the training form warns when a long run has no early stopping (#125).
- Line crops are cut plainly, without painting out what lies outside the outline (#129).
- Models that fit on the card stay loaded together instead of being swapped for every page (#128).
- Every account has one role, as in Label Studio: Admin, Manager, Reviewer, Annotator or Viewer
  (#131). Annotators correct and add pages, Reviewers also check, Managers also run models, change
  settings, export and delete; whoever made a dataset manages it. Members become Managers. Running
  layout, lines and OCR, discarding checked work and deleting are no longer granted per person.
- Every dataset sits in a workspace, open to its members, or in its creator's private Sandbox (#131).
  A workspace's Managers manage its people; only an empty workspace is deleted; admins' visits to
  a dataset are no longer recorded. New job asks which workspace a dataset is made in, and a + on
  each workspace starts one there. Nobody sees a workspace they do not belong to: a dataset given
  to them on its own is listed under Shared with you.
- A Members dialog replaces Share, as in Label Studio (#132): it lists a workspace's or a
  dataset's people with their roles, adds someone by typing their name and saves each change at
  once. On one dataset it makes an Annotator a Reviewer, or a Reviewer an Annotator.
- Line corrections are saved unchecked; checking is a step of its own.
- The page editor: labels on every box in edit mode (#77), lines that stay in the box they lie in
  (#71), a class pressed over gathered shapes draws a tight box (#74), Ctrl draws over a selected
  shape (#70), and edits show at once and are saved in the background, each one revision-checked
  (#72, #81, #82).
- Scans scroll sideways with Shift and the wheel (#68), and the held wheel button pans (#69).
- The transcript loads a page at a time, searches on the server and fills the window (#47, #48).
- The dataset page, the viewer bar, the dataset list, the runs table and the people table are
  regrouped around what is used most.
- Large uploads are sent in parts.
- Log out ends the Authentik session as well (#66).
- New API tokens last a year by default (#34); "Opening a page" settings are now "Default
  visibility" (#32).

### Fixed

- Deleting a training run no longer fails when its model had read pages or was named as
  replaced by a newer one (#152).
- A running layout or line run's page shows its best on its own headline (box mAP50, F1)
  instead of "best cer", and the epoch it keeps by the metric its trainer keeps it by (#151).
- The page editor's Run menu opens in full again, no longer cut off by the editor bar (#144).
- A training chart with a single reported point draws it as a dot instead of looking empty (#143).
- The training pre-flight counts a small layout set's steps at the 200 pages an epoch trains (#148).
- A layout model trained on classes of its own reads with those names, not the Schematismus
  ones (#147).
- A training's log no longer shows the trainer's terminal colour codes (#145).
- The admin page and the top bar count the same people as online: anyone with DeepLabel open,
  in view or in a background tab, viewers too (#139).
- A skipped layout is no longer called found, and a page names the step it failed in (#43).
- Checked lines stay checked through an ALTO export and import (#59).
- The app finds the backend and the sign-in service again after their containers are recreated (#51).
- A late answer can no longer set off a second reload of the dataset page (#65).
- A save on its way when a page is left still reaches the server (#92).
- The run page's Data tab no longer scrolls the whole window (#117); a zoomed training chart has a
  Reset zoom button (#116).
- The editors keep their place in a narrow window (#109), and a hint cut short there shows in full
  on hover (#111).
- A taken dataset name is refused on the first step of New job.

## [0.1.0] - 2026-10-23

The first public release.

[Unreleased]: https://github.com/m2key1/DeepLabel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/m2key1/DeepLabel/releases/tag/v0.1.0
