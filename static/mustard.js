function event(selector, ev, func) {
	document.querySelectorAll(selector).forEach(el => el["on" + ev] = func);
}

const setupform = document.forms.setups.elements;
const schedform = document.forms.schedule.elements;

function render_setups() {
	const rows = setups.map((s, i) => TR({onclick: () => pick_setup(i)}, [
		TD(0, s.category),
		TD(0, s.title),
		TD(0, s.tags),
		TD(0, s.tweet),
		TD(0, BUTTON({className: "deleting", id: "del"+i, onclick: () => try_delete_setup(i)}, "X")),
	]));
	const table = document.getElementById("setups");
	while (table.lastChild != table.firstChild) table.removeChild(table.lastChild); //Keep the header row only
	rows.forEach(row => table.appendChild(row));
}

function pick_setup(i) {
	const setup = setups[i];
	if (!setup) return; //Shouldn't happen
	setupform.category.value = setup.category;
	setupform.title.value = setup.title;
	setupform.tags.value = setup.tags;
	document.getElementById("tweet").value = setup.tweet;
}

let deleting_setup = -1;
let delete_time = 0;
function try_delete_setup(i) {
	if (deleting_setup != i) {
		//Await confirmation via a second click
		document.querySelectorAll(".deleting").forEach(b => b.innerHTML = "X");
		document.getElementById("del" + i).innerHTML = "Delete?";
		deleting_setup = i;
		delete_time = +new Date + 1;
		return;
	}
	if (+new Date < delete_time) return;
	//Okay, let's actually delete it.
	deleting_setup = -1;
	document.getElementById("del" + i).innerHTML = "X";
	delete_setup(setups[i].id);
}

/*
document.getElementById("hello").onclick = async function() {
	const result = await (await fetch("/api/hello", {credentials: "include"})).json();
	console.log(result);
}
*/

document.getElementById("save").onclick = async function() {
	const result = await (await fetch("/api/setups?channelid=" + channel._id, {
		credentials: "include",
		headers: {"Content-Type": "application/json"},
		method: "POST",
		body: JSON.stringify({
			category: setupform.category.value,
			title: setupform.title.value,
			tags: setupform.tags.value,
			tweet: document.getElementById("tweet").value,
		})
	})).json();
	setups.push(result);
	render_setups();
}

async function delete_setup(i) {
	const result = await fetch("/api/setups/" + i + "?channelid=" + channel._id, {
		credentials: "include",
		method: "DELETE",
	});
	if (!result.ok) return;
	setups = await (await fetch("/api/setups?channelid=" + channel._id, {credentials: "include"})).json();
	render_setups();
}

function tidy_times(times) {
	times = times.replace(",", " ").split(" ");
	for (let i = 0; i < times.length; ++i)
	{
		const tm = times[i];
		//Reformat tm tidily
		//If tm is exactly "AM" or "PM" (case insensitively),
		//apply the transformation to the previous entry, and discard
		//this one. That will allow "9 pm" to parse correctly.
		//Edge case: "9  pm" still doesn't parse. Whatevs.
		const which = /^(AM)?(PM)?$/i.exec(tm);
		if (which && i && times[i-1] != "")
		{
			let [hr, min] = times[i-1].split(":");
			if (hr == "12") hr = "00";
			if (which[2]) hr = ("0" + (parseInt(hr, 10) + 12)).slice(-2);
			times[i-1] = hr + ":" + min;
			times[i] = "";
			continue;
		}
		//Yes, that's "?::" in a regex. Don't you just LOVE it when a
		//character is sometimes special, sometimes literal?
		//I'm abusing regex a little here; the last bit really should be
		//(AM|PM)?, but there's no way to say "but which of the alternation
		//did you match?". So by splitting it into two matchable parts, I
		//take advantage of the regex case-insensitivity flag. That DOES
		//mean that "2:30AMPM" will match. Simple rule: PM wins. (Just ask
		//Jim Hacker if you don't believe me. Except when he's PM.)
		const parts = /^([0-9][0-9]?)(?::([0-9][0-9]?))?(AM)?(PM)?$/i.exec(tm);
		if (!parts) {times[i] = ""; continue;} //Will end up getting completely suppressed
		let hour = parseInt(parts[1], 10);
		let min = parseInt(parts[2] || "00", 10);
		if (parts[3] || parts[4]) //AM or PM was set
		{
			if (hour == 12) hour = 0;
			if (parts[4]) hour += 12; //PM
		}
		times[i] = ("0" + hour).slice(-2) + ":" + ("0" + min).slice(-2);
	}
	return times.sort().join(" ").trim();
}

event(".sched", "change", function() {
	schedule[this.name[5]] = this.value = tidy_times(this.value);
});

document.getElementById("tweet").oninput = function() {
	document.getElementById("tweetlen").innerHTML = this.value.length;
};

event("form.ajax", "submit", async function(ev) {
	ev.preventDefault();
	const dest = new URL(this.action);
	const data = {}; new FormData(this).forEach((v,k) => data[k] = v);
	const result = await (await fetch("/api" + dest.pathname + "?channelid=" + channel._id, {
		credentials: "include",
		headers: {"Content-Type": "application/json"},
		method: "POST",
		body: JSON.stringify(data)
	})).json();
	set_content(document.getElementById("messages"), [
		result.error && DIV({className: "errormessage"}, result.error),
		result.warning && DIV({className: "warningmessage"}, result.warning),
		result.success && DIV({className: "successmessage"}, result.success),
	]);
	document.getElementById("messages").scrollIntoView();
});

function timediff(timestr, date) {
	//Calculate the difference between a time string and a date.
	//Yes, it's weird. It's a helper for g_n_s_t below. Nothing more.
	//Can and will return a negative number of seconds if timestr
	//represents a time earlier in the day than date does.
	const [hr, min] = timestr.split(":");
	const tm = parseInt(hr, 10) * 60 + parseInt(min, 10);
	const secs = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
	return tm * 60 - secs;
}

function get_next_scheduled_time(offset) {
	//Returns [dow, time, days, tm]
	//dow - day of week (0-6)
	//time - HH:MM
	//days - number of days into the future (might be 0, might be 7)
	//tm - number of seconds from now until that time.
	//If no times on the schedule, returns [].
	const now = new Date(new Date() - (offset||0)*1000);
	const today = now.getDay(); //0 = Sunday, 1 = Monday, etc
	//Cycle from today forwards, wrapping, until we find a valid time
	//If we get all the way back to today, look at times behind us.
	const today_times = schedule[today].split(" ").filter(x => x);
	if (today_times.length) {
		//Find one that's after the current time
		const time = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
		for (let t of today_times) if (t > time) {
			return [today, t, 0, timediff(t, now)];
		}
	}
	//Nope? Okay, let's try tomorrow.
	for (let days = 1; days < 7; ++days) {
		const times = schedule[(today + days) % 7].split(" ").filter(x => x);
		if (times.length) return [(today + days) % 7, times[0], days, days*86400 + timediff(times[0], now)];
	}
	//Nothing at all? Alright, one last try, looking at today.
	//If there is anything at all on today's schedule, and we didn't return
	//from the previous block, then what we want is to wait all the way around
	//the week until we get back to today, and then take the earliest time
	//slot available. Seven days and negative a few hours.
	if (today_times.length) return [today, today_times[0], 7, 604800 + timediff(today_times[0], now)];
	//If we get here, the entire schedule must be empty.
	return [];
}

function format_schedule_time(offset) {
	const [dow, time, days, delay] = get_next_scheduled_time(offset);
	if (!time) return null;
	const hh = Math.floor(delay / 3600);
	const mm = ("0" + Math.floor((delay / 60) % 60)).slice(-2);
	const ss = ("0" + Math.floor(delay % 60)).slice(-2);
	const downame = "Sun Mon Tue Wed Thu Fri Sat".split(" ")[dow];
	let day;
	if (!days) day = "Today";
	else if (days == 1) day = "Tomorrow";
	else if (days == 7) day = "Next " + downame
	else day = downame;
	return `${day} ${time} ==> ${hh}:${mm}:${ss}`;
}

setInterval(function() {
	document.getElementById("nextsched").innerHTML = format_schedule_time() || "(none)";
	const tweet = document.getElementById("tweetschedule");
	document.getElementById("tweettime").innerHTML =
		tweet.value === "now" ? "Immediate" :
		format_schedule_time(+tweet.value) || "(need schedule)";
}, 1000);

setupform.category.value = channel.game;
setupform.title.value = channel.status;
setupform.tags.value = channel.tags;
render_setups();

const local_tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (sched_tz === "") {
	//No saved TZ - assume you probably want the one you're using in the browser.
	schedform.sched_tz.value = local_tz;
} else {
	schedform.sched_tz.value = sched_tz;
	if (sched_tz !== local_tz) {
		//Your saved timezone and your browser timezone are different.
		//Notify the user.
		document.getElementById("othertz").innerHTML = "(Your browser's preferred timezone is: " + local_tz + ")";
	}
}

set_content(document.getElementById("checklist"),
	document.forms.checklist.elements.checklist.value
	.trim().split("\n")
	.map(item => item && LI(0, LABEL(0, [INPUT({type: "checkbox"}), item])))
);

schedule.forEach((times, day) => schedform["sched" + day].value = tidy_times(times));

event(".timer-adjust", "click", function() {
	fetch("/timer-adjust-all/" + this.dataset.delta + "?channelid=" + channel._id, {credentials: "include"})
		.catch(err => console.error(err));
});
function force_timers(timestr) {
	const [min, sec] = timestr.split(":");
	const tm = parseInt(min, 10) * 60 + parseInt(sec||"0", 10);
	if (tm <= 0 || tm > 3600) return; //TODO: Handle these better
	fetch("/timer-force-all/" + tm + "?channelid=" + channel._id, {credentials: "include"})
		.catch(err => console.error(err));
}
document.getElementById("set-timer").onclick = () => force_timers(document.getElementById("targettime").value);
event(".timer-force", "click", function() {force_timers(this.innerHTML);});

const pickmapper = {
	game: game => LI({"data-pick": game.localized_name}, [IMG({src: game.box.small, alt: ""}), game.localized_name]),
	tag: tag => LI({"data-pick": tag.english_name}, tag.english_name + ": " + tag.english_desc),
};
let picking = "";
function open_picker(now_picking, heading) {
	picking = now_picking;
	document.getElementById("picker_search").value = "";
	document.getElementById("picker_results").innerHTML = "";
	document.getElementById("picker_heading").innerHTML = heading;
	document.getElementById("picker").showModal();
	document.getElementById("picker_search").oninput(); //Do an initial search immediately
}
document.getElementById("pick_cat").onclick = function(ev) {open_picker("game", "Pick a category:"); ev.preventDefault();}
document.getElementById("pick_tag").onclick = function(ev) {open_picker("tag", "Select tags:"); ev.preventDefault();}

let searching = false;
document.getElementById("picker_search").oninput = async function() {
	let val = this.value;
	if (searching) return;
	while (true)
	{
		try {
			searching = true;
			const res = await (await fetch(`/search/${picking}?q=` + encodeURIComponent(val))).json();
			set_content(document.getElementById("picker_results"), res.map(pickmapper[picking]));
		}
		finally {
			searching = false;
		}
		//If the input has changed since we started searching, redo the search.
		if (val === this.value) break;
		val = this.value;
	}
}

document.getElementById("picker_results").onclick = function(event) {
	let li = event.target;
	while (li && li.tagName != "LI" && li != event.currentTarget) li = li.parentElement;
	if (li.tagName != "LI") return;
	if (picking === "game")
	{
		document.getElementById("category").value = li.dataset.pick;
		document.getElementById("picker").close();
	}
	else
	{
		const t = document.getElementById("tags");
		const tags = t.value.split(", "); //NOTE: The back end splits on "," and strips spaces.
		if (tags.includes(li.dataset.pick)) return; //Already got it
		tags.push(li.dataset.pick); tags.sort();
		while (tags[0] === "") tags.shift(); //Any empty string(s) should have sorted first
		t.value = tags.join(", ");
	}
}
document.getElementById("picker_cancel").onclick = () => document.getElementById("picker").close();

document.getElementById("prev_section").onclick = () => {
	const cur = document.querySelector("section.current");
	let next = cur.previousElementSibling;
	if (next.tagName != "SECTION") {
		const all = document.querySelectorAll("section");
		next = all[all.length - 1];
	}
	next.classList.add("current");
	cur.classList.remove("current");
}
document.getElementById("next_section").onclick = () => {
	const cur = document.querySelector("section.current");
	let next = cur.nextElementSibling;
	if (next.tagName != "SECTION") next = document.querySelector("section"); //Loop back to start
	next.classList.add("current");
	cur.classList.remove("current");
}

event("form", "keydown", function(ev) {
	//On Ctrl-Enter, submit the form.
	//TODO: What do Mac users expect? Check specifically with Twitter.
	//If they expect Meta-Enter, can we handle that? Better still, is
	//there a generic event that we should be hooking?
	if (ev.ctrlKey && ev.keyCode === 13) ev.currentTarget.submit();
});

//For browsers with only partial support for the <dialog> tag, add the barest minimum.
//On browsers with full support, there are many advantages to using dialog rather than
//plain old div, but this way, other browsers at least have it pop up and down.
document.querySelectorAll("dialog").forEach(dlg => {
	if (!dlg.showModal) dlg.showModal = function() {this.style.display = "block";}
	if (!dlg.close) dlg.close = function() {this.style.removeProperty("display");}
});
