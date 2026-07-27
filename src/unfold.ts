/**
 * For each ASCII letter and digit, every code point that `normalizeText` folds
 * to it — the inverse of the fold, which cannot be computed forwards.
 *
 * Lets a gate built from a normalized query run against the caller's own
 * un-normalized strings: `e` becomes a class holding `e E é É ế …`, so no
 * normalized copy of the corpus has to exist before the first query can filter.
 *
 * ASCII targets only, and deliberately: that is 554 code points in under a
 * kilobyte, where every fold target in the BMP would be 1,275 of them. A query
 * carrying anything outside this table gets no raw gate and takes the mask path
 * instead — slower, never wrong.
 *
 * Generated, and pinned by test/unfold.test.ts, which walks the whole BMP and
 * fails if any code point folds to an ASCII character this table omits. Do not
 * hand-edit: a missing source is a gate that false-rejects.
 */
export const UNFOLD: Record<string, string> = {
	"0": "0",
	"1": "1",
	"2": "2",
	"3": "3",
	"4": "4",
	"5": "5",
	"6": "6",
	"7": "7",
	"8": "8",
	"9": "9",
	"a": "AaÀÁÂÃÄÅàáâãäåĀāĂăĄąǍǎǞǟǠǡǺǻȀȁȂȃȦȧḀḁẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặÅ",
	"b": "BbḂḃḄḅḆḇ",
	"c": "CcÇçĆćĈĉĊċČčḈḉ",
	"d": "DdĎďḊḋḌḍḎḏḐḑḒḓ",
	"e": "EeÈÉÊËèéêëĒēĔĕĖėĘęĚěȄȅȆȇȨȩḔḕḖḗḘḙḚḛḜḝẸẹẺẻẼẽẾếỀềỂểỄễỆệ",
	"f": "FfḞḟ",
	"g": "GgĜĝĞğĠġĢģǦǧǴǵḠḡ",
	"h": "HhĤĥȞȟḢḣḤḥḦḧḨḩḪḫẖ",
	"i": "IiÌÍÎÏìíîïĨĩĪīĬĭĮįİǏǐȈȉȊȋḬḭḮḯỈỉỊị",
	"j": "JjĴĵǰ",
	"k": "KkĶķǨǩḰḱḲḳḴḵK",
	"l": "LlĹĺĻļĽľŁłḶḷḸḹḺḻḼḽ",
	"m": "MmḾḿṀṁṂṃ",
	"n": "NnÑñŃńŅņŇňǸǹṄṅṆṇṈṉṊṋ",
	"o": "OoÒÓÔÕÖòóôõöŌōŎŏŐőƠơǑǒǪǫǬǭȌȍȎȏȪȫȬȭȮȯȰȱṌṍṎṏṐṑṒṓỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợ",
	"p": "PpṔṕṖṗ",
	"q": "Qq",
	"r": "RrŔŕŖŗŘřȐȑȒȓṘṙṚṛṜṝṞṟ",
	"s": "SsŚśŜŝŞşŠšȘșṠṡṢṣṤṥṦṧṨṩ",
	"t": "TtŢţŤťȚțṪṫṬṭṮṯṰṱẗ",
	"u": "UuÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųƯưǓǔǕǖǗǘǙǚǛǜȔȕȖȗṲṳṴṵṶṷṸṹṺṻỤụỦủỨứỪừỬửỮữỰự",
	"v": "VvṼṽṾṿ",
	"w": "WwŴŵẀẁẂẃẄẅẆẇẈẉẘ",
	"x": "XxẊẋẌẍ",
	"y": "YyÝýÿŶŷŸȲȳẎẏẙỲỳỴỵỶỷỸỹ",
	"z": "ZzŹźŻżŽžẐẑẒẓẔẕ",
};
