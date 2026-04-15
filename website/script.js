document.addEventListener('DOMContentLoaded', () => {
    // Select all elements with the fade-in-up class
    const fadeElements = document.querySelectorAll('.fade-in-up');

    // Create an Intersection Observer
    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            // If the element is in the viewport
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                // Optional: Stop observing once the animation has triggered
                observer.unobserve(entry.target);
            }
        });
    }, {
        root: null, // Use the viewport as the root
        threshold: 0.1, // Trigger when 10% of the element is visible
        rootMargin: '0px 0px -50px 0px' // Slightly trigger before the element is fully in view
    });

    // Observe each element
    fadeElements.forEach(el => {
        observer.observe(el);
    });
});
