-- Hadrius Studio installer: the GUI half of "Install Hadrius Studio.app".
--
-- installer/build.sh compiles this file and bundles install.sh (which does all the real work) and
-- team.env (the shared team credentials) into the app's Contents/Resources. This script only shows
-- dialogs, a progress window and the Chrome walkthrough. install.sh reports progress through
-- <stateDir>/status, one tab-separated line: percent, state (running/done/error), title, detail.

property appTitle : "Hadrius Studio Installer"

on run
	set installScript to POSIX path of (path to resource "install.sh")
	set appIcon to path to resource "applet.icns"
	set stateDir to (POSIX path of (path to library folder from user domain)) & "Logs/Hadrius Studio Installer"
	do shell script "mkdir -p " & quoted form of stateDir

	-- An install still running from an earlier launch (the app was quit mid-install): just show it.
	set pid to my runningInstall(stateDir)
	if pid is "" then
		if my bridgeIsUp() then
			set choice to button returned of (display dialog "Hadrius Studio is already installed on this Mac." & return & return & "Update & Repair downloads the latest version and re-applies the team settings (a few minutes). Sign In to Claude only reconnects Claude." buttons {"Cancel", "Sign In to Claude", "Update & Repair"} default button "Update & Repair" cancel button "Cancel" with title appTitle with icon appIcon)
			if choice is "Sign In to Claude" then
				my claudeSignIn(installScript, stateDir)
				return
			end if
		else
			display dialog "This installs Hadrius Studio and connects it to the team's accounts. There's nothing to type or set up." & return & return & "It takes about 5 to 10 minutes. If macOS asks to install the “command line developer tools”, click Install." buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel" with title appTitle with icon appIcon
		end if
		set pid to my startInstall(installScript, stateDir)
	end if

	if not my watchInstall(pid, stateDir, appIcon) then return

	set installDir to do shell script "cat " & quoted form of (stateDir & "/install-dir")
	set movedFrom to ""
	try
		set movedFrom to do shell script "cat " & quoted form of (stateDir & "/moved-from")
	end try
	set chromeNote to my setUpChrome(installScript, installDir & "/extension", movedFrom, appIcon)
	my offerClaude(installScript, stateDir, appIcon)
	my finish(stateDir, installDir, movedFrom, chromeNote, appIcon)
end run

-- Runs install.sh in the background in its own process group (set -m), so Stop can end the whole
-- tree (setup.sh, npm, pip…) with one kill. Returns its pid.
on startInstall(installScript, stateDir)
	do shell script "rm -f " & quoted form of (stateDir & "/status")
	return do shell script "/bin/bash -c 'set -m; /bin/bash \"$0\" install \"$1\" </dev/null >/dev/null 2>&1 & echo $!' " & quoted form of installScript & " " & quoted form of stateDir
end startInstall

on runningInstall(stateDir)
	try
		return do shell script "p=$(cat " & quoted form of (stateDir & "/pid") & ") && kill -0 \"$p\" && echo \"$p\""
	on error
		return ""
	end try
end runningInstall

on bridgeIsUp()
	try
		return (do shell script "curl -s --max-time 2 http://127.0.0.1:8787/health") contains "\"ok\":true"
	on error
		return false
	end try
end bridgeIsUp

on isAlive(pid)
	try
		do shell script "kill -0 " & pid
		return true
	on error
		return false
	end try
end isAlive

-- {percent, state, title, detail}, or missing value before install.sh has written anything.
on readStatus(statusFile)
	try
		set statusInfo to do shell script "cat " & quoted form of statusFile
	on error
		return missing value
	end try
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to tab
	set parts to text items of statusInfo
	set AppleScript's text item delimiters to oldDelims
	if (count of parts) < 4 then return missing value
	set pct to 0
	try
		set pct to (item 1 of parts) as integer
	end try
	return {pct, item 2 of parts, item 3 of parts, item 4 of parts}
end readStatus

on watchInstall(pid, stateDir, appIcon)
	set statusFile to stateDir & "/status"
	set logFile to stateDir & "/install.log"
	set progress total steps to 100
	set progress completed steps to 0
	set progress description to "Installing Hadrius Studio…"
	set progress additional description to "Starting…"
	try
		repeat
			delay 0.5
			-- Check the process before reading: if it had already exited, the status read after is final.
			set alive to my isAlive(pid)
			set statusInfo to my readStatus(statusFile)
			if statusInfo is not missing value then
				set progress completed steps to (item 1 of statusInfo)
				set progress description to (item 3 of statusInfo)
				set progress additional description to (item 4 of statusInfo)
				if (item 2 of statusInfo) is "done" then return true
				if (item 2 of statusInfo) is "error" then
					my showError(item 3 of statusInfo, item 4 of statusInfo, logFile)
					return false
				end if
			end if
			if not alive then
				my showError("The installer stopped unexpectedly.", "", logFile)
				return false
			end if
		end repeat
	on error errMsg number errNum
		if errNum is not -128 then error errMsg number errNum
		-- The progress window's Stop button.
		do shell script "kill -TERM -- -" & pid & " 2>/dev/null; true"
		display dialog "Installation stopped. Run the installer again any time to finish." buttons {"OK"} default button "OK" with title appTitle with icon appIcon
		return false
	end try
end watchInstall

on showError(title, detail, logFile)
	set msg to title
	if detail is not "" then set msg to msg & return & return & detail
	set msg to msg & return & return & "Run the installer again to retry. If it keeps failing, send Stephen the install log (Show Log)."
	set choice to button returned of (display dialog msg buttons {"Show Log", "Close"} default button "Close" with title appTitle with icon stop)
	if choice is "Show Log" then do shell script "open -R " & quoted form of logFile
end showError

on chromeStatus(installScript, extDir, movedFrom)
	set r to {isLoaded:false, devMode:false, isDisabled:false, oldPath:""}
	try
		set out to do shell script "/bin/bash " & quoted form of installScript & " chrome-status " & quoted form of extDir & " " & quoted form of movedFrom
	on error
		return r
	end try
	repeat with ln in paragraphs of out
		set ln to ln as text
		if ln is "loaded=1" then set isLoaded of r to true
		if ln is "devmode=1" then set devMode of r to true
		if ln is "disabled=1" then set isDisabled of r to true
		if ln starts with "old=" and (length of ln) > 4 then set oldPath of r to text 5 thru -1 of ln
	end repeat
	return r
end chromeStatus

on openChromeExtensions()
	try
		tell application "Google Chrome"
			activate
			if (count of windows) is 0 then make new window
			tell front window to make new tab with properties {URL:"chrome://extensions/"}
		end tell
	on error
		-- Not allowed to control Chrome: open it and let them paste the address instead.
		set the clipboard to "chrome://extensions"
		do shell script "open -a 'Google Chrome'"
		display dialog "Chrome is open. Click its address bar, paste (⌘V) and press Return to open the Extensions page." buttons {"OK"} default button "OK" with title appTitle
	end try
end openChromeExtensions

-- Guides the one step that can't be automated: loading the unpacked extension. Each step checks
-- itself off by watching Chrome's preferences. Returns a note for the final dialog ("" if none).
on setUpChrome(installScript, extDir, movedFrom, appIcon)
	set s to my chromeStatus(installScript, extDir, movedFrom)
	if isLoaded of s then
		my openChromeExtensions()
		return "It's already in Chrome. On the Extensions page that just opened, click the reload arrow (⟳) on the Hadrius Studio card to load the new version."
	end if
	set intro to "Last step: add Hadrius Studio to Chrome. It takes about a minute." & return & return & "Chrome will open its Extensions page, and a Finder window will show a folder named “extension”. A small progress window tells you what to do next and checks off each step by itself."
	if movedFrom is not "" and (oldPath of s) is not "" then
		set intro to intro & return & return & "Hadrius Studio moved out of your Downloads folder, so Chrome needs it added again. On the Extensions page, click Remove on the old Hadrius Studio card (it may show an error) first."
	else if (oldPath of s) is not "" then
		set intro to intro & return & return & "Chrome also has an older copy of Hadrius Studio. Click Remove on its card first."
	end if
	display dialog intro buttons {"Open Chrome"} default button "Open Chrome" with title appTitle with icon appIcon
	my openChromeExtensions()
	do shell script "open -R " & quoted form of extDir

	set progress total steps to 2
	set lastStep to ""
	try
		repeat
			set s to my chromeStatus(installScript, extDir, movedFrom)
			if isLoaded of s then exit repeat
			if not (devMode of s) then
				set stepName to "devmode"
				set progress completed steps to 0
				set progress description to "Turn on Developer mode"
				set progress additional description to "Click the “Developer mode” switch in the top right corner of Chrome's Extensions page."
			else if isDisabled of s then
				set stepName to "enable"
				set progress completed steps to 1
				set progress description to "Turn Hadrius Studio on"
				set progress additional description to "Click the switch on the Hadrius Studio card so it turns blue."
			else
				set stepName to "load"
				set progress completed steps to 1
				set progress description to "Add the extension"
				set progress additional description to "Drag the “extension” folder from the Finder window onto Chrome's Extensions page. (Or click “Load unpacked” and choose that folder.)"
			end if
			-- A step just got checked off: bring the next instruction to the front.
			if lastStep is not "" and stepName is not lastStep then activate
			set lastStep to stepName
			delay 1.5
		end repeat
	on error errMsg number errNum
		if errNum is not -128 then error errMsg number errNum
		return "To add it to Chrome later: open chrome://extensions, turn on Developer mode, click Load unpacked and choose this folder:" & return & extDir
	end try
	set progress completed steps to 2
	set progress description to "Added to Chrome"
	set progress additional description to ""
	activate
	return ""
end setUpChrome

on offerClaude(installScript, stateDir, appIcon)
	set checks to ""
	try
		set checks to do shell script "cat " & quoted form of (stateDir & "/checks")
	end try
	if checks contains "claude=1" and checks contains "codebase=1" then return
	set choice to button returned of (display dialog "Recommended: sign in to Claude." & return & return & "Studio uses Claude and the Hadrius codebase to write narration and plans. Click Sign In: a Terminal window opens and your browser asks you to sign in. There's nothing to type in Terminal." & return & return & "If you skip this, narration, plans and Pylon articles won't work until you sign in. To sign in later, run this installer again (or run claude in Terminal)." buttons {"Skip", "Sign In"} default button "Sign In" with title appTitle with icon appIcon)
	if choice is "Sign In" then my claudeSignIn(installScript, stateDir)
end offerClaude

on claudeSignIn(installScript, stateDir)
	do shell script "/bin/bash " & quoted form of installScript & " claude-signin " & quoted form of stateDir
end claudeSignIn

on finish(stateDir, installDir, movedFrom, chromeNote, appIcon)
	set warnings to ""
	try
		set warnings to do shell script "cat " & quoted form of (stateDir & "/warnings")
	end try
	set msg to "Hadrius Studio is installed."
	if movedFrom is not "" then set msg to msg & return & return & "It now lives in your home folder (" & installDir & "), so clearing out Downloads won't break it."
	if chromeNote is not "" then set msg to msg & return & return & chromeNote
	set msg to msg & return & return & "• Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to Hadrius Studio." & return & "• Open app.hadrius.com and click the Hadrius Studio icon to open the side panel." & return & "• When the side panel says “update available”, click it to update."
	if warnings is not "" then set msg to msg & return & return & "Some team connections aren't working. Tell Stephen:" & return & warnings
	set choice to button returned of (display dialog msg buttons {"Done", "Open Hadrius"} default button "Open Hadrius" with title appTitle with icon appIcon)
	if choice is "Open Hadrius" then do shell script "open -a 'Google Chrome' 'https://app.hadrius.com'"
end finish
