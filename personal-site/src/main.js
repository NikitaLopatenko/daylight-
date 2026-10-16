const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

const topbar = document.querySelector(".topbar");
const onScroll = () => {
  if (!topbar) return;
  topbar.classList.toggle("scrolled", window.scrollY > 12);
};
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

const reveals = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );
  reveals.forEach((node) => observer.observe(node));
} else {
  reveals.forEach((node) => node.classList.add("visible"));
}
